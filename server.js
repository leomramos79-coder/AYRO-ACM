const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const MIN_COMPARAVEIS = 3;
const MAX_COMPARAVEIS = 10;
const TOLERANCIA_AREA = 0.40;

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

function numeroBR(valor){
  if(valor===null||valor===undefined||valor==='') return null;
  let s=String(valor).trim().replace(/\s/g,'').replace(/^R\$/i,'').replace(/[^0-9.,]/g,'');
  if(!s) return null;
  if(s.includes(',') && s.includes('.')) s=s.replace(/\./g,'').replace(',','.');
  else if(s.includes(',')) s=s.replace(',','.');
  else if(/^\d{1,3}(\.\d{3})+$/.test(s)) s=s.replace(/\./g,'');
  const n=Number(s); return Number.isFinite(n)?n:null;
}

function moeda(v){
  return Number.isFinite(v)
    ? v.toLocaleString('pt-BR',{
        style:'currency',
        currency:'BRL',
        maximumFractionDigits:0
      })
    : null;
}

function mediana(a){
  const v=a.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!v.length)return null;
  const m=Math.floor(v.length/2);
  return v.length%2?v[m]:(v[m-1]+v[m])/2;
}

function media(a){
  const v=a.filter(Number.isFinite);
  return v.length?v.reduce((x,y)=>x+y,0)/v.length:null;
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
      'fbclid'
    ].forEach(k=>u.searchParams.delete(k));

    return (u.origin+u.pathname).replace(/\/$/,'');
  }catch{
    return String(link).split('?')[0].replace(/\/$/,'');
  }
}

function dadosDaBusca(q){

  const nq=norm(q);

  const tipo=
    /apartamento|\bapto\b|flat|studio/.test(nq)
      ? 'apartamento'
      : /\bcasa\b|sobrado/.test(nq)
        ? 'casa'
        : '';

  const qm=nq.match(
    /(\d+)\s*(?:quartos?|dormitorios?|dorms?|qtos?)/i
  );

  const am=nq.match(
    /(\d+(?:[.,]\d+)?)\s*m(?:²|2)\b/i
  );

  const local=(
    nq.split(
      /\b(?:\d+\s*(?:quartos?|dormitorios?|dorms?|qtos?)|\d+(?:[.,]\d+)?\s*m(?:²|2))\b/i
    )[0] || ''
  )
  .replace(
    /apartamento|\bapto\b|flat|studio|\bcasa\b|sobrado|a venda|venda/gi,
    ' '
  )
  .replace(/\s+/g,' ')
  .trim();

  const tokensLocal=local
    .split(/\s+/)
    .filter(
      x=>x.length>=3 &&
      !['para','com','imovel'].includes(x)
    );

  return {
    tipo,
    quartos:qm?Number(qm[1]):null,
    area:am?numeroBR(am[1]):null,
    tokensLocal
  };
}

function textoCompleto(item){

  let extra='';

  try{
    extra=JSON.stringify({
      rich_snippet:item.rich_snippet||{},
      detected_extensions:item.detected_extensions||{},
      extensions:item.extensions||[]
    });
  }catch{}

  return `${item.title||''} ${item.snippet||''} ${extra}`;
}

function extrairPreco(texto,item){

  const candidatos=[];

  for(const key of ['price','preco']){
    if(item?.[key]!=null){
      candidatos.push(String(item[key]));
    }
  }

  const re=
    /R\$\s*[0-9]{2,3}(?:[.\s][0-9]{3})*(?:,[0-9]{2})?|R\$\s*[0-9]{5,9}/gi;

  for(const m of String(texto).match(re)||[]){
    candidatos.push(m);
  }

  const walk=(o,depth=0)=>{

    if(!o||depth>4)return;

    if(Array.isArray(o)){
      return o.forEach(v=>walk(v,depth+1));
    }

    if(typeof o==='object'){

      for(const [k,v] of Object.entries(o)){

        if(
          /price|preco/i.test(k) &&
          (typeof v==='string'||typeof v==='number')
        ){
          candidatos.push(String(v));
        }else{
          walk(v,depth+1);
        }
      }
    }
  };

  walk(item?.rich_snippet);
  walk(item?.detected_extensions);

  for(const c of candidatos){

    const n=numeroBR(c);

    if(
      Number.isFinite(n) &&
      n>=50000 &&
      n<=100000000
    ){
      return {
        texto:`R$ ${Math.round(n).toLocaleString('pt-BR')}`,
        valor:n
      };
    }
  }

  return {
    texto:'',
    valor:null
  };
}

function extrairArea(texto,areaAlvo){

  const vals=[];

  for(
    const m of String(texto).matchAll(
      /(\d+(?:[.,]\d+)?)\s*m(?:²|2)\b/gi
    )
  ){

    const n=numeroBR(m[1]);

    if(
      Number.isFinite(n) &&
      n>=15 &&
      n<=100000
    ){
      vals.push(n);
    }
  }

  if(!vals.length){
    return {
      texto:'',
      valor:null
    };
  }

  const un=[...new Set(vals)];

  const n=Number.isFinite(areaAlvo)
    ? un.sort(
        (a,b)=>
          Math.abs(a-areaAlvo)-
          Math.abs(b-areaAlvo)
      )[0]
    : un[0];

  return {
    texto:`${String(n).replace('.',',')} m²`,
    valor:n
  };
}

function paginaColetiva(titulo,texto,link){

  const t=norm(titulo);
  const all=norm(texto);
  const l=String(link||'').toLowerCase();

  const contagem=
    /\b\d+\s+(?:imoveis|apartamentos|casas|anuncios)\b/.test(t);

  const tituloCategoria=
    /^(?:imoveis|apartamentos|casas)\s+(?:para|a)\s+venda\b/.test(t) ||
    /(?:imoveis|apartamentos|casas)\s+(?:para|a)\s+venda\s+em\b/.test(t);

  const urlBusca=
    /\/busca(?:\/|\?|$)|\/search(?:\/|\?|$)|[?&](?:q|busca|search)=/i.test(l);

  /*
    IMPORTANTE:
    não descarta simplesmente porque a URL contém /imoveis/.
    Muitos anúncios individuais usam essa estrutura.
  */

  return (
    contagem ||
    tituloCategoria ||
    urlBusca ||
    (
      /pagina\s+\d+/.test(all) &&
      !/R\$/.test(texto)
    )
  );
}

function avaliarItem(item,busca){

  const titulo=item.title||'';
  const descricao=item.snippet||'';
  const link=item.link||'';

  const texto=textoCompleto(item);
  const nt=norm(texto);

  const p=extrairPreco(texto,item);
  const a=extrairArea(texto,busca.area);

  const temApto=
    /apartamento|\bapto\b|flat|studio/.test(nt);

  const temCasa=
    /\bcasa\b|sobrado/.test(nt);

  let tipoStatus='desconhecido';

  if(busca.tipo==='apartamento'){

    tipoStatus=
      temApto&&!temCasa
        ? 'ok'
        : temCasa
          ? 'divergente'
          : 'desconhecido';

  }else if(busca.tipo==='casa'){

    tipoStatus=
      temCasa&&!temApto
        ? 'ok'
        : temApto
          ? 'divergente'
          : 'desconhecido';

  }else{

    tipoStatus='ok';
  }

  let quartosStatus='ok';

  if(busca.quartos){

    const nums=[
      ...nt.matchAll(
        /(\d+)\s*(?:quartos?|dormitorios?|dorms?|qtos?)/g
      )
    ].map(
      m=>Number(m[1])
    );

    quartosStatus=
      !nums.length
        ? 'desconhecido'
        : nums.includes(busca.quartos)
          ? 'ok'
          : 'divergente';
  }

  let diferencaArea=null;
  let areaOk=Number.isFinite(a.valor);

  if(busca.area&&a.valor){

    diferencaArea=
      Math.abs(a.valor-busca.area)/
      busca.area;

    areaOk=
      diferencaArea<=TOLERANCIA_AREA;
  }

  const social=
    /instagram\.com|facebook\.com|youtube\.com|tiktok\.com|pinterest\./i.test(link);

  const coletiva=
    paginaColetiva(
      titulo,
      texto,
      link
    );

  const localHits=
    (busca.tokensLocal||[])
      .filter(
        t=>nt.includes(t)
      ).length;

  /*
    Divergência explícita elimina.

    Se o Google simplesmente não mostrar
    alguma informação no resumo,
    isso não elimina automaticamente
    o anúncio.
  */

  const valido=
    Boolean(link) &&
    Number.isFinite(p.valor) &&
    Number.isFinite(a.valor) &&
    areaOk &&
    tipoStatus!=='divergente' &&
    quartosStatus!=='divergente' &&
    !social &&
    !coletiva;

  let score=0;

  score+=
    tipoStatus==='ok'
      ?25
      :tipoStatus==='desconhecido'
        ?10
        :0;

  score+=
    quartosStatus==='ok'
      ?20
      :quartosStatus==='desconhecido'
        ?8
        :0;

  if(Number.isFinite(diferencaArea)){

    score+=Math.max(
      0,
      35*(
        1-
        diferencaArea/
        TOLERANCIA_AREA
      )
    );
  }

  if(p.valor&&a.valor){
    score+=10;
  }

  score+=Math.min(
    10,
    localHits*3
  );

  const precoM2=
    p.valor&&a.valor
      ?p.valor/a.valor
      :null;

  return {

    titulo,
    descricao,
    link,

    fonte:
      item.source||
      item.displayed_link||
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

    diagnostico:{

      tipoStatus,
      quartosStatus,

      areaOk,
      diferencaArea,

      localHits,

      social,

      paginaColetiva:
        coletiva,

      temPreco:
        Number.isFinite(p.valor),

      temArea:
        Number.isFinite(a.valor)
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
      d.error||
      'Erro ao consultar a SerpApi.'
    );
  }

  return d.organic_results||[];
}

function semOutliers(comps){

  if(comps.length<4){
    return comps;
  }

  const v=
    comps
      .map(x=>x.preco_m2)
      .filter(Number.isFinite)
      .sort((a,b)=>a-b);

  if(v.length<4){
    return comps;
  }

  const pick=
    p=>v[
      Math.floor(
        (v.length-1)*p
      )
    ];

  const q1=pick(.25);
  const q3=pick(.75);

  const iqr=q3-q1;

  const min=
    q1-
    1.5*iqr;

  const max=
    q3+
    1.5*iqr;

  const f=
    comps.filter(
      x=>
        x.preco_m2>=min &&
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
    !area ||
    comps.length<MIN_COMPARAVEIS
  ){

    return {

      calculada:false,

      motivo:
        !area
          ?'Informe a área do imóvel na pesquisa para calcular a avaliação.'
          :`Foram encontrados apenas ${comps.length} comparáveis válidos. São necessários pelo menos ${MIN_COMPARAVEIS}.`
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

    return {

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

  return {

    calculada:true,

    metodologia:
      'Mediana do preço por m² dos comparáveis válidos; outliers são removidos quando há base suficiente. Resultados com divergência explícita de tipo, quartos ou área são excluídos.',

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
        'PRECISAO-V5',

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

        return res.status(400).json({

          erro:
            'Informe uma pesquisa.'
        });
      }

      const apiKey=
        process.env.SERPAPI_KEY;

      if(!apiKey){

        return res.status(500).json({

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

          for(const raw of organic){

            const x=
              avaliarItem(
                raw,
                busca
              );

            if(!x.link){
              continue;
            }

            const k=
              normalizarLink(
                x.link
              );

            if(
              vistos.has(k)
            ){
              continue;
            }

            vistos.add(k);

            unicos.push(x);
          }
        };

      /*
        BUSCA 1:
        consulta completa.
      */

      const baseQ=
        `${q} imóvel anúncio R$ m² -youtube -instagram -facebook -tiktok`;

      /*
        BUSCA 2:
        retira a área da consulta,
        mas continua validando a área
        depois.
      */

      const semArea=
        q
          .replace(
            /\b\d+(?:[.,]\d+)?\s*m(?:²|2)\b/i,
            ''
          )
          .replace(
            /\s{2,}/g,
            ' '
          )
          .trim();

      /*
        BUSCA 3:
        amplia ainda mais a descoberta,
        retirando quartos da consulta.

        Depois o filtro continua
        verificando divergências.
      */

      const semAreaQuartos=
        semArea
          .replace(
            /\b\d+\s*(?:quartos?|dormitórios?|dormitorios?|dorms?|qtos?)\b/i,
            ''
          )
          .replace(
            /\s{2,}/g,
            ' '
          )
          .trim();

      const consultas=[

        baseQ,

        `${semArea} imóvel à venda preço R$ m² -youtube -instagram -facebook -tiktok`,

        `${semAreaQuartos} imóvel à venda preço R$ m² -youtube -instagram -facebook -tiktok`
      ];

      let chamadas=0;

      for(
        const consulta of
        [...new Set(consultas)]
      ){

        const encontrados=
          await buscarSerp(
            apiKey,
            consulta,
            20
          );

        adicionar(
          encontrados
        );

        chamadas++;

        const quantidadeValidos=
          unicos.filter(
            x=>x.comparavel_valido
          ).length;

        /*
          Quando já houver uma amostra
          boa, não precisa gastar outra
          chamada da API.
        */

        if(
          quantidadeValidos>=6
        ){
          break;
        }
      }

      let comparaveis=
        unicos
          .filter(
            x=>x.comparavel_valido
          )
          .sort(
            (a,b)=>
              b.score_similaridade-
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
              b.score_similaridade-
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
          'PRECISAO-V5',

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

      res.status(500).json({

        erro:
          'Erro interno na pesquisa.',

        detalhe:
          e.message||
          String(e)
      });
    }
  }
);

const PORT=
  process.env.PORT||
  3000;

app.listen(
  PORT,
  ()=>console.log(
    `AYRO ACM API PRECISAO-V5 rodando na porta ${PORT}`
  )
);
