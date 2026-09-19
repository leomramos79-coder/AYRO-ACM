const express=require('express');
const cors=require('cors');
const app=express();

app.use(cors());
app.use(express.json());

const MIN_COMPARAVEIS=3;
const MAX_COMPARAVEIS=10;
const TOLERANCIA_AREA=0.35;

const norm=s=>String(s||'')
.normalize('NFD')
.replace(/[\u0300-\u036f]/g,'')
.toLowerCase();

function numeroBR(v){
  if(v==null||v==='')return null;

  let s=String(v)
    .trim()
    .replace(/\s/g,'')
    .replace(/^R\$/i,'')
    .replace(/[^0-9.,]/g,'');

  if(!s)return null;

  if(s.includes(',')&&s.includes('.'))
    s=s.replace(/\./g,'').replace(',','.');

  else if(s.includes(','))
    s=s.replace(',','.');

  else if(/^\d{1,3}(\.\d{3})+$/.test(s))
    s=s.replace(/\./g,'');

  const n=Number(s);

  return Number.isFinite(n)?n:null;
}

function moeda(v){
  return Number.isFinite(v)
    ?v.toLocaleString('pt-BR',{
        style:'currency',
        currency:'BRL',
        maximumFractionDigits:0
      })
    :null;
}

function mediana(a){
  const v=a
    .filter(Number.isFinite)
    .sort((x,y)=>x-y);

  if(!v.length)return null;

  const m=Math.floor(v.length/2);

  return v.length%2
    ?v[m]
    :(v[m-1]+v[m])/2;
}

function media(a){
  const v=a.filter(Number.isFinite);

  return v.length
    ?v.reduce((x,y)=>x+y,0)/v.length
    :null;
}

function normalizarLink(link=''){
  try{
    const u=new URL(link);

    [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
      'relatedAds'
    ].forEach(k=>u.searchParams.delete(k));

    return (u.origin+u.pathname).replace(/\/$/,'');

  }catch{
    return String(link)
      .split('?')[0]
      .replace(/\/$/,'');
  }
}

function dadosDaBusca(q){

  const nq=norm(q);

  const tipo=
    /apartamento|\bapto\b|flat|studio/.test(nq)
      ?'apartamento'
      :/\bcasa\b|sobrado/.test(nq)
        ?'casa'
        :'';

  const qm=nq.match(
    /(\d+)\s*(?:quartos?|dormitorios?|dorms?|qtos?)/i
  );

  const am=nq.match(
    /(\d+(?:[.,]\d+)?)\s*m(?:²|2)(?![a-z0-9])/i
  );

  return{
    tipo,
    quartos:qm?Number(qm[1]):null,
    area:am?numeroBR(am[1]):null
  };
}

function dadosDaUrl(link=''){

  let s='';

  try{
    s=decodeURIComponent(
      String(link||'')
    ).toLowerCase();

  }catch{
    s=String(link||'').toLowerCase();
  }

  const q=s.match(
    /(?:-|\/)(\d+)-quartos?(?:-|\/)/i
  );

  const a=s.match(
    /(?:-|\/)(\d+(?:[.,]\d+)?)(?:m2|m²)(?:-|\/)/i
  );

  const p=s.match(
    /(?:-|\/)(?:rs|r\$)(\d{5,9})(?:\/|\?|$)/i
  );

  return{
    quartos:q?Number(q[1]):null,
    area:a?numeroBR(a[1]):null,
    preco:p?numeroBR(p[1]):null
  };
}

function ehLinkIndividual(link=''){

  const l=String(link||'').toLowerCase();

  if(!l)return false;

  if(
    /chavesnamao\.com\.br\/imovel\//i.test(l)
    &&
    /\/id-\d+/i.test(l)
  ){
    return true;
  }

  if(
    /imovelweb\.com\.br\/propriedades\//i.test(l)
  ){
    return true;
  }

  if(
    /(?:zapimoveis|vivareal)\.com\.br\/imovel\//i.test(l)
  ){
    return true;
  }

  if(
    /\/(?:imovel|imoveis)\//i.test(l)
    &&
    !/\/(?:busca|search)\/?(?:\?|$)/i.test(l)
  ){
    return true;
  }

  return false;
}

function extrairPreco(texto,item,urlData){

  const c=[];

  if(Number.isFinite(urlData?.preco))
    c.push(urlData.preco);

  for(const k of ['price','preco']){
    if(item?.[k]!=null)
      c.push(item[k]);
  }

  for(
    const m of
    String(texto).match(
      /R\$\s*[0-9]{2,3}(?:[.\s][0-9]{3})*(?:,[0-9]{2})?|R\$\s*[0-9]{5,9}/gi
    )||[]
  ){
    c.push(m);
  }

  for(const x of c){

    const n=
      typeof x==='number'
        ?x
        :numeroBR(x);

    if(
      Number.isFinite(n)
      &&
      n>=50000
      &&
      n<=100000000
    ){
      return{
        texto:`R$ ${Math.round(n).toLocaleString('pt-BR')}`,
        valor:n
      };
    }
  }

  return{
    texto:'',
    valor:null
  };
}

function extrairArea(texto,alvo,urlData){

  const vals=[];

  if(Number.isFinite(urlData?.area))
    vals.push(urlData.area);

  for(
    const m of String(texto).matchAll(
      /(\d+(?:[.,]\d+)?)\s*m(?:²|2)(?![a-z0-9])/gi
    )
  ){

    const n=numeroBR(m[1]);

    if(
      Number.isFinite(n)
      &&
      n>=15
      &&
      n<=100000
    ){
      vals.push(n);
    }
  }

  const u=[...new Set(vals)];

  if(!u.length){
    return{
      texto:'',
      valor:null
    };
  }

  const n=
    Number.isFinite(alvo)
      ?u.sort(
          (a,b)=>
            Math.abs(a-alvo)
            -
            Math.abs(b-alvo)
        )[0]
      :u[0];

  return{
    texto:`${String(n).replace('.',',')} m²`,
    valor:n
  };
}

function avaliarItem(item,busca){

  const titulo=item.title||'';
  const descricao=item.snippet||'';
  const link=item.link||'';

  const texto=
    `${titulo} ${descricao}`;

  const nt=norm(texto);

  const ud=dadosDaUrl(link);

  const p=
    extrairPreco(
      texto,
      item,
      ud
    );

  const a=
    extrairArea(
      texto,
      busca.area,
      ud
    );

  const motivos=[];

  if(!ehLinkIndividual(link)){
    motivos.push(
      'link não é anúncio individual'
    );
  }

  if(!Number.isFinite(p.valor)){
    motivos.push(
      'sem preço identificado'
    );
  }

  if(!Number.isFinite(a.valor)){
    motivos.push(
      'sem área identificada'
    );
  }

  const temApto=
    /apartamento|\bapto\b|flat|studio/.test(nt);

  const temCasa=
    /\bcasa\b|sobrado/.test(nt);

  let tipoStatus='ok';

  if(
    busca.tipo==='apartamento'
    &&
    temCasa
    &&
    !temApto
  ){
    tipoStatus='divergente';
  }

  if(
    busca.tipo==='casa'
    &&
    temApto
    &&
    !temCasa
  ){
    tipoStatus='divergente';
  }

  if(tipoStatus==='divergente'){
    motivos.push(
      'tipo de imóvel divergente'
    );
  }

  let quartosStatus='desconhecido';

  if(busca.quartos){

    const nums=[
      ...nt.matchAll(
        /(\d+)\s*(?:quartos?|dormitorios?|dorms?|qtos?)/g
      )
    ].map(
      m=>Number(m[1])
    );

    if(Number.isFinite(ud.quartos)){
      nums.unshift(
        ud.quartos
      );
    }

    quartosStatus=
      !nums.length
        ?'desconhecido'
        :nums.includes(busca.quartos)
          ?'ok'
          :'divergente';

    if(quartosStatus==='divergente'){
      motivos.push(
        'quantidade de quartos divergente'
      );
    }
  }

  let diferencaArea=null;

  if(busca.area&&a.valor){

    diferencaArea=
      Math.abs(
        a.valor-busca.area
      )
      /
      busca.area;

    if(
      diferencaArea>
      TOLERANCIA_AREA
    ){
      motivos.push(
        'área fora da faixa'
      );
    }
  }

  const valido=
    motivos.length===0;

  const precoM2=
    p.valor&&a.valor
      ?p.valor/a.valor
      :null;

  let score=0;

  score+=
    tipoStatus==='ok'
      ?25
      :0;

  score+=
    quartosStatus==='ok'
      ?25
      :quartosStatus==='desconhecido'
        ?8
        :0;

  if(
    Number.isFinite(
      diferencaArea
    )
  ){

    score+=Math.max(
      0,
      40*
      (
        1-
        diferencaArea/
        TOLERANCIA_AREA
      )
    );
  }

  if(precoM2)
    score+=10;

  return{

    titulo,
    descricao,
    link,

    fonte:
      item.source
      ||
      item.displayed_link
      ||
      '',

    preco:p.texto,
    area:a.texto,

    preco_valor:p.valor,
    area_valor:a.valor,

    preco_m2:precoM2,

    score_similaridade:
      Math.round(score),

    comparavel_valido:
      valido,

    motivo_descarte:
      valido
        ?''
        :motivos.join('; '),

    diagnostico:{
      individual:
        ehLinkIndividual(link),

      tipoStatus,
      quartosStatus,
      diferencaArea
    }
  };
}

async function buscarSerp(
  apiKey,
  q,
  num=20
){

  const params=
    new URLSearchParams({

      engine:'google',

      q,

      location:'Brazil',

      hl:'pt-br',

      gl:'br',

      num:String(num),

      api_key:apiKey
    });

  const r=
    await fetch(
      `https://serpapi.com/search.json?${params}`
    );

  const d=
    await r.json();

  if(!r.ok||d.error){

    throw new Error(
      d.error
      ||
      'Erro ao consultar a SerpApi.'
    );
  }

  return d.organic_results||[];
}

function semOutliers(comps){

  if(comps.length<4)
    return comps;

  const v=
    comps
      .map(x=>x.preco_m2)
      .filter(Number.isFinite)
      .sort((a,b)=>a-b);

  if(v.length<4)
    return comps;

  const q1=
    v[
      Math.floor(
        (v.length-1)*.25
      )
    ];

  const q3=
    v[
      Math.floor(
        (v.length-1)*.75
      )
    ];

  const iqr=q3-q1;

  const min=
    q1-1.5*iqr;

  const max=
    q3+1.5*iqr;

  const f=
    comps.filter(
      x=>
        x.preco_m2>=min
        &&
        x.preco_m2<=max
    );

  return f.length>=MIN_COMPARAVEIS
    ?f
    :comps;
}

function calcularAvaliacao(
  comps,
  area
){

  if(
    !area
    ||
    comps.length<
    MIN_COMPARAVEIS
  ){

    return{
      calculada:false,

      motivo:
        !area
          ?
          'Informe a área do imóvel na pesquisa para calcular a avaliação.'
          :
          `Foram encontrados apenas ${comps.length} comparáveis válidos. São necessários pelo menos ${MIN_COMPARAVEIS}.`
    };
  }

  const base=
    semOutliers(comps);

  const m2s=
    base
      .map(x=>x.preco_m2)
      .filter(Number.isFinite);

  const med=
    mediana(m2s);

  const avg=
    media(m2s);

  if(!med){

    return{
      calculada:false,
      motivo:
        'Não foi possível calcular o valor por m².'
    };
  }

  const mercado=
    med*area;

  const rapida=
    mercado*.95;

  const maximo=
    mercado*1.05;

  return{

    calculada:true,

    metodologia:
      'Mediana do preço por m² de anúncios individuais válidos, com remoção de outliers quando há base suficiente.',

    comparaveis_usados:
      base.length,

    area_avaliada_m2:
      area,

    preco_m2_mediano:
      Math.round(med),

    preco_m2_medio:
      Math.round(avg),

    valor_venda_rapida:
      Math.round(rapida),

    valor_mercado:
      Math.round(mercado),

    valor_maximo_sugerido:
      Math.round(maximo),

    valores_formatados:{

      venda_rapida:
        moeda(rapida),

      mercado:
        moeda(mercado),

      maximo_sugerido:
        moeda(maximo)
    }
  };
}

app.get(
  '/',
  (req,res)=>
    res.json({

      status:
        'AYRO ACM API online',

      versao:
        'PRECISAO-V7',

      minimo_comparaveis:
        MIN_COMPARAVEIS
    })
);

app.get(
  [
    '/api/pesquisar',
    '/api/search',
    '/search'
  ],

  async(req,res)=>{

    try{

      const q=
        String(
          req.query.q||''
        ).trim();

      if(!q){

        return res
          .status(400)
          .json({
            erro:
              'Informe uma pesquisa.'
          });
      }

      const apiKey=
        process.env.SERPAPI_KEY;

      if(!apiKey){

        return res
          .status(500)
          .json({
            erro:
              'SERPAPI_KEY não configurada no servidor.'
          });
      }

      const busca=
        dadosDaBusca(q);

      const vistos=
        new Set();

      const unicos=[];

      const adicionar=
        organic=>{

          for(
            const raw of organic
          ){

            const x=
              avaliarItem(
                raw,
                busca
              );

            if(!x.link)
              continue;

            const k=
              normalizarLink(
                x.link
              );

            if(
              vistos.has(k)
            )
              continue;

            vistos.add(k);

            unicos.push(x);
          }
        };

      const consultas=[

        `site:chavesnamao.com.br/imovel ${q} -aluguel`,

        `site:zapimoveis.com.br/imovel ${q} -aluguel`,

        `site:vivareal.com.br/imovel ${q} -aluguel`,

        `site:imovelweb.com.br/propriedades ${q} -aluguel`,

        `${q} imóvel anúncio individual R$ m² -youtube -instagram -facebook -tiktok`
      ];

      let chamadas=0;

      for(
        const consulta of consultas
      ){

        adicionar(
          await buscarSerp(
            apiKey,
            consulta,
            30
          )
        );

        chamadas++;

        if(
          unicos.filter(
            x=>x.comparavel_valido
          ).length>=8
        ){
          break;
        }
      }

      const comparaveis=
        unicos
          .filter(
            x=>x.comparavel_valido
          )
          .sort(
            (a,b)=>
              b.score_similaridade
              -
              a.score_similaridade
          )
          .slice(
            0,
            MAX_COMPARAVEIS
          );

      const referencias=
        unicos
          .filter(
            x=>!x.comparavel_valido
          )
          .sort(
            (a,b)=>
              b.score_similaridade
              -
              a.score_similaridade
          );

      const avaliacao=
        calcularAvaliacao(
          comparaveis,
          busca.area
        );

      res.json({

        sucesso:true,

        versao:
          'PRECISAO-V7',

        consulta:q,

        criterios:
          busca,

        chamadas_busca:
          chamadas,

        total:
          unicos.length,

        total_comparaveis:
          comparaveis.length,

        minimo_comparaveis:
          MIN_COMPARAVEIS,

        comparaveis,

        referencias,

        avaliacao,

        resultados:[
          ...comparaveis,
          ...referencias
        ]
      });

    }catch(e){

      console.error(
        'ERRO AYRO:',
        e
      );

      res
        .status(500)
        .json({

          erro:
            'Erro interno na pesquisa.',

          detalhe:
            e.message
            ||
            String(e)
        });
    }
  }
);

const PORT=
  process.env.PORT
  ||
  3000;

if(
  require.main===module
){

  app.listen(
    PORT,
    ()=>
      console.log(
        `AYRO ACM API PRECISAO-V7 rodando na porta ${PORT}`
      )
  );
}

module.exports={
  app,
  dadosDaBusca,
  dadosDaUrl,
  ehLinkIndividual,
  avaliarItem,
  calcularAvaliacao
};
