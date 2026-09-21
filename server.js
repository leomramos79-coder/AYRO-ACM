const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

const MIN_COMPARAVEIS = 3;
const MAX_COMPARAVEIS = 10;
const TOLERANCIA_AREA = 0.30;
const SIMILARIDADE_PREFERENCIAL = 70;
const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 100;

const searchCache = new Map();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 Chrome/126 Safari/537.36';

const norm = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const moeda = v =>
  Number.isFinite(v)
    ? v.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0
      })
    : null;

const numero = v => {
  if (v === null || v === undefined || v === '') return null;

  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }

  let s = String(v)
    .replace(/\s/g, '')
    .replace(/R\$/gi, '')
    .replace(/[^\d,.-]/g, '');

  if (!s) return null;

  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }

  const n = Number(s);

  return Number.isFinite(n) ? n : null;
};

const inteiro = v => {
  const n = numero(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

const limparTexto = texto =>
  String(texto || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

function limitar(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function mediana(valores) {
  const arr = valores
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!arr.length) return null;

  const meio = Math.floor(arr.length / 2);

  if (arr.length % 2) return arr[meio];

  return (arr[meio - 1] + arr[meio]) / 2;
}

function media(valores) {
  const arr = valores.filter(Number.isFinite);

  if (!arr.length) return null;

  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function desvioPadrao(valores) {
  const arr = valores.filter(Number.isFinite);

  if (arr.length < 2) return 0;

  const m = media(arr);

  const variancia =
    arr.reduce((soma, valor) => soma + Math.pow(valor - m, 2), 0) /
    arr.length;

  return Math.sqrt(variancia);
}

function cacheGet(chave) {
  const item = searchCache.get(chave);

  if (!item) return null;

  if (Date.now() - item.criado > CACHE_TTL_MS) {
    searchCache.delete(chave);
    return null;
  }

  return item.valor;
}

function cacheSet(chave, valor) {
  if (searchCache.size >= CACHE_MAX) {
    const primeira = searchCache.keys().next().value;
    searchCache.delete(primeira);
  }

  searchCache.set(chave, {
    criado: Date.now(),
    valor
  });
}

async function fetchComTimeout(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT_MS
  );

  try {
    const resposta = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept:
          'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        ...(options.headers || {})
      }
    });

    return resposta;
  } finally {
    clearTimeout(timeout);
  }
}

function urlValida(url) {
  try {
    const u = new URL(url);

    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function dominio(url) {
  try {
    return new URL(url).hostname
      .replace(/^www\./, '')
      .toLowerCase();
  } catch {
    return '';
  }
}

function ehLinkIndividual(url) {
  if (!urlValida(url)) return false;

  const u = norm(url);

  const sinais = [
    '/imovel/',
    '/imoveis/',
    '/anuncio/',
    '/anuncios/',
    '/apartamento/',
    '/casa/',
    '/terreno/',
    '/property/',
    '/properties/'
  ];

  return sinais.some(s => u.includes(s));
}

function extrairJsonLd(html) {
  const resultados = [];

  const regex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match;

  while ((match = regex.exec(html))) {
    try {
      const obj = JSON.parse(match[1]);

      if (Array.isArray(obj)) {
        resultados.push(...obj);
      } else if (obj && obj['@graph']) {
        resultados.push(...obj['@graph']);
      } else {
        resultados.push(obj);
      }
    } catch {}
  }

  return resultados;
}

function procurarNumeroEmTexto(texto, regexes) {
  for (const regex of regexes) {
    const m = texto.match(regex);

    if (m && m[1]) {
      const n = numero(m[1]);

      if (Number.isFinite(n)) return n;
    }
  }

  return null;
}

function procurarInteiroEmTexto(texto, regexes) {
  const n = procurarNumeroEmTexto(texto, regexes);

  return Number.isFinite(n) ? Math.round(n) : null;
}

function extrairPreco(texto) {
  return procurarNumeroEmTexto(texto, [
    /R\$\s*([\d.]+(?:,\d{1,2})?)/i,
    /pre[cç]o[^\d]{0,20}([\d.]+(?:,\d{1,2})?)/i,
    /valor[^\d]{0,20}([\d.]+(?:,\d{1,2})?)/i
  ]);
}

function extrairArea(texto) {
  return procurarNumeroEmTexto(texto, [
    /([\d.,]+)\s*m²/i,
    /([\d.,]+)\s*m2/i,
    /área[^\d]{0,20}([\d.,]+)/i,
    /area[^\d]{0,20}([\d.,]+)/i
  ]);
}

function extrairQuartos(texto) {
  return procurarInteiroEmTexto(texto, [
    /(\d+)\s*quartos?/i,
    /(\d+)\s*dormit[oó]rios?/i,
    /(\d+)\s*quarto/i
  ]);
}

function extrairBanheiros(texto) {
  return procurarInteiroEmTexto(texto, [
    /(\d+)\s*banheiros?/i,
    /(\d+)\s*banheiro/i
  ]);
}

function extrairVagas(texto) {
  return procurarInteiroEmTexto(texto, [
    /(\d+)\s*vagas?/i,
    /(\d+)\s*garagens?/i
  ]);
}

function extrairSuites(texto) {
  return procurarInteiroEmTexto(texto, [
    /(\d+)\s*su[ií]tes?/i,
    /(\d+)\s*su[ií]te/i
  ]);
}

function extrairTitulo(html) {
  const og =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
    );

  if (og?.[1]) return limparTexto(og[1]);

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  return title?.[1] ? limparTexto(title[1]) : '';
}

function extrairDescricao(html) {
  const meta =
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i
    );

  return meta?.[1] ? limparTexto(meta[1]) : '';
}

function dadosDaUrl(url, html) {
  const titulo = extrairTitulo(html);
  const descricao = extrairDescricao(html);

  const texto = limparTexto(`${titulo} ${descricao} ${html}`);

  let preco = extrairPreco(texto);
  let area = extrairArea(texto);
  let quartos = extrairQuartos(texto);
  let banheiros = extrairBanheiros(texto);
  let vagas = extrairVagas(texto);
  let suites = extrairSuites(texto);

  const jsons = extrairJsonLd(html);

  for (const obj of jsons) {
    if (!obj || typeof obj !== 'object') continue;

    const offers =
      obj.offers ||
      obj.priceSpecification ||
      {};

    if (!preco) {
      preco =
        numero(offers.price) ||
        numero(obj.price) ||
        numero(obj.lowPrice);
    }

    if (!area) {
      area =
        numero(obj.floorSize?.value) ||
        numero(obj.area?.value) ||
        numero(obj.floorSize);
    }

    if (!quartos) {
      quartos =
        inteiro(obj.numberOfRooms) ||
        inteiro(obj.numberOfBedrooms);
    }

    if (!banheiros) {
      banheiros =
        inteiro(obj.numberOfBathroomsTotal) ||
        inteiro(obj.numberOfBathrooms);
    }
  }

  const valorM2 =
    Number.isFinite(preco) &&
    Number.isFinite(area) &&
    area > 0
      ? preco / area
      : null;

  return {
    titulo,
    url,
    dominio: dominio(url),
    preco,
    area,
    valor_m2: valorM2,
    quartos,
    suites,
    banheiros,
    vagas,
    texto: `${titulo} ${descricao}`.trim()
  };
}

async function extrairDaPagina(url) {
  if (!urlValida(url)) return null;

  try {
    const resposta = await fetchComTimeout(url);

    if (!resposta.ok) return null;

    const tipo = resposta.headers.get('content-type') || '';

    if (
      !tipo.includes('text/html') &&
      !tipo.includes('application/xhtml')
    ) {
      return null;
    }

    const html = await resposta.text();

    if (!html || html.length < 100) return null;

    return dadosDaUrl(url, html);
  } catch {
    return null;
  }
}

function extrairLinks(html, baseUrl) {
  const links = new Set();

  const regex =
    /<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi;

  let match;

  while ((match = regex.exec(html))) {
    try {
      const url = new URL(match[1], baseUrl).href;

      if (urlValida(url) && ehLinkIndividual(url)) {
        links.add(url);
      }
    } catch {}
  }

  return [...links];
}

async function buscarLinksEmPagina(url) {
  try {
    const resposta = await fetchComTimeout(url);

    if (!resposta.ok) return [];

    const html = await resposta.text();

    return extrairLinks(html, url);
  } catch {
    return [];
  }
}

function similaridadeTexto(a, b) {
  const aa = new Set(
    norm(a)
      .split(/\W+/)
      .filter(x => x.length >= 3)
  );

  const bb = new Set(
    norm(b)
      .split(/\W+/)
      .filter(x => x.length >= 3)
  );

  if (!aa.size || !bb.size) return 0;

  let iguais = 0;

  for (const item of aa) {
    if (bb.has(item)) iguais++;
  }

  return (iguais / Math.max(aa.size, bb.size)) * 100;
}

function tipoImovel(texto) {
  const t = norm(texto);

  if (t.includes('apartamento')) return 'apartamento';

  if (t.includes('casa') || t.includes('residencia')) {
    return 'casa';
  }

  if (t.includes('terreno') || t.includes('lote')) {
    return 'terreno';
  }

  if (t.includes('sitio')) return 'sitio';

  if (t.includes('cobertura')) return 'cobertura';

  if (t.includes('loja') || t.includes('comercial')) {
    return 'comercial';
  }

  return '';
}

function avaliarItem(item, alvo) {
  if (
    !item ||
    !Number.isFinite(item.preco) ||
    item.preco <= 0 ||
    !Number.isFinite(item.area) ||
    item.area <= 0
  ) {
    return {
      valido: false,
      score: 0,
      motivo: 'Sem preço ou área confiável.'
    };
  }

  const vm2 = item.preco / item.area;

  if (!Number.isFinite(vm2) || vm2 < 500 || vm2 > 50000) {
    return {
      valido: false,
      score: 0,
      motivo: 'Valor por m² fora da faixa plausível.'
    };
  }

  let score = 50;

  const areaAlvo = numero(alvo.area);

  if (Number.isFinite(areaAlvo) && areaAlvo > 0) {
    const diferenca = Math.abs(item.area - areaAlvo) / areaAlvo;

    if (diferenca <= TOLERANCIA_AREA) {
      score += 20;
    } else if (diferenca <= 0.5) {
      score += 8;
    } else {
      score -= 15;
    }
  }

  const tipoAlvo = tipoImovel(
    `${alvo.tipo || ''} ${alvo.descricao || ''}`
  );

  const tipoItem = tipoImovel(
    `${item.titulo || ''} ${item.texto || ''}`
  );

  if (tipoAlvo && tipoItem) {
    if (tipoAlvo === tipoItem) {
      score += 15;
    } else {
      score -= 15;
    }
  }

  const quartosAlvo = inteiro(alvo.quartos);

  if (
    Number.isFinite(quartosAlvo) &&
    Number.isFinite(item.quartos)
  ) {
    const d = Math.abs(quartosAlvo - item.quartos);

    if (d === 0) score += 10;
    else if (d === 1) score += 3;
    else score -= 5;
  }

  const textoAlvo = [
    alvo.bairro,
    alvo.cidade,
    alvo.endereco,
    alvo.condominio,
    alvo.descricao
  ]
    .filter(Boolean)
    .join(' ');

  const sim = similaridadeTexto(
    textoAlvo,
    `${item.titulo} ${item.texto}`
  );

  if (sim >= SIMILARIDADE_PREFERENCIAL) {
    score += 15;
  } else if (sim >= 35) {
    score += 7;
  }

  return {
    valido: score >= 35,
    score: limitar(Math.round(score), 0, 100),
    valor_m2: vm2,
    similaridade: Math.round(sim)
  };
}function removerOutliers(comparaveis) {
  if (comparaveis.length < 4) return comparaveis;

  const valores = comparaveis
    .map(x => x.valor_m2)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const med = mediana(valores);

  if (!Number.isFinite(med)) return comparaveis;

  return comparaveis.filter(item => {
    const diferenca = Math.abs(item.valor_m2 - med) / med;
    return diferenca <= 0.45;
  });
}

function calcularAvaliacao(comparaveis, areaAlvo) {
  const validos = removerOutliers(
    comparaveis.filter(
      x => Number.isFinite(x.valor_m2) && x.valor_m2 > 0
    )
  );

  if (!validos.length) {
    return {
      quantidade: 0,
      valor_m2_medio: null,
      valor_m2_mediano: null,
      valor_conservador: null,
      valor_mercado: null,
      valor_otimista: null,
      confianca: 0
    };
  }

  const valoresM2 = validos.map(x => x.valor_m2);

  const med = mediana(valoresM2);
  const medMedia = media(valoresM2);

  const valorBase = med * 0.7 + medMedia * 0.3;

  const desvio = desvioPadrao(valoresM2);

  const coefVariacao =
    valorBase > 0 ? desvio / valorBase : 1;

  const area = numero(areaAlvo);

  const valorMercado =
    Number.isFinite(area) && area > 0
      ? valorBase * area
      : null;

  const margem = limitar(
    0.06 + coefVariacao * 0.20,
    0.06,
    0.15
  );

  let confianca =
    45 +
    validos.length * 7 -
    coefVariacao * 45;

  confianca = limitar(
    Math.round(confianca),
    35,
    95
  );

  return {
    quantidade: validos.length,

    valor_m2_medio:
      Math.round(medMedia),

    valor_m2_mediano:
      Math.round(med),

    valor_m2_referencia:
      Math.round(valorBase),

    valor_conservador:
      Number.isFinite(valorMercado)
        ? Math.round(valorMercado * (1 - margem))
        : null,

    valor_mercado:
      Number.isFinite(valorMercado)
        ? Math.round(valorMercado)
        : null,

    valor_otimista:
      Number.isFinite(valorMercado)
        ? Math.round(valorMercado * (1 + margem))
        : null,

    confianca,

    margem_percentual:
      Math.round(margem * 100)
  };
}

function dadosDaBusca(body = {}) {
  return {
    tipo: String(
      body.tipo ||
      body.tipo_imovel ||
      ''
    ).trim(),

    finalidade: String(
      body.finalidade ||
      'venda'
    ).trim(),

    endereco: String(
      body.endereco ||
      ''
    ).trim(),

    bairro: String(
      body.bairro ||
      ''
    ).trim(),

    cidade: String(
      body.cidade ||
      'Teresópolis'
    ).trim(),

    estado: String(
      body.estado ||
      'RJ'
    ).trim(),

    condominio: String(
      body.condominio ||
      ''
    ).trim(),

    area: numero(
      body.area ||
      body.area_util ||
      body.area_construida
    ),

    quartos: inteiro(
      body.quartos
    ),

    suites: inteiro(
      body.suites
    ),

    banheiros: inteiro(
      body.banheiros
    ),

    vagas: inteiro(
      body.vagas
    ),

    descricao: String(
      body.descricao ||
      ''
    ).trim(),

    links: Array.isArray(body.links)
      ? body.links
      : []
  };
}

function montarTermoBusca(alvo) {
  return [
    alvo.tipo,
    alvo.bairro,
    alvo.condominio,
    alvo.cidade,
    alvo.estado,
    alvo.quartos
      ? `${alvo.quartos} quartos`
      : '',
    alvo.area
      ? `${Math.round(alvo.area)} m2`
      : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function urlsFornecidas(alvo) {
  const lista = [];

  for (const item of alvo.links || []) {
    const url =
      typeof item === 'string'
        ? item
        : item?.url;

    if (url && urlValida(url)) {
      lista.push(url);
    }
  }

  return [...new Set(lista)];
}

async function coletarComparaveis(alvo) {
  const urls = urlsFornecidas(alvo);

  const resultados = [];

  for (const url of urls.slice(0, 20)) {
    const item = await extrairDaPagina(url);

    if (!item) continue;

    const avaliacao = avaliarItem(
      item,
      alvo
    );

    if (avaliacao.valido) {
      resultados.push({
        ...item,
        ...avaliacao
      });
    }

    if (
      resultados.length >=
      MAX_COMPARAVEIS
    ) {
      break;
    }
  }

  return resultados;
}

function ordenarComparaveis(lista) {
  return [...lista].sort((a, b) => {
    const score =
      (b.score || 0) -
      (a.score || 0);

    if (score !== 0) return score;

    return (
      (b.similaridade || 0) -
      (a.similaridade || 0)
    );
  });
}

function limparComparaveisDuplicados(lista) {
  const mapa = new Map();

  for (const item of lista) {
    if (!item?.url) continue;

    const chave = item.url
      .split('?')[0]
      .replace(/\/$/, '');

    const atual = mapa.get(chave);

    if (
      !atual ||
      (item.score || 0) >
        (atual.score || 0)
    ) {
      mapa.set(
        chave,
        item
      );
    }
  }

  return [...mapa.values()];
}

/* ==========================================
   ROTAS PRINCIPAIS
========================================== */

app.get('/', (req, res) => {
  res.json({
    sistema: 'AYRO ACM Pro',
    status: 'online',
    versao: 'PRECISAO-V13-MP-SUPABASE',
    pagamento: 'Mercado Pago',
    banco: 'Supabase'
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    servico: 'AYRO ACM API',
    versao: 'PRECISAO-V13-MP-SUPABASE',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/avaliar', async (req, res) => {
  try {
    const alvo = dadosDaBusca(
      req.body
    );

    if (
      !Number.isFinite(alvo.area) ||
      alvo.area <= 0
    ) {
      return res
        .status(400)
        .json({
          erro:
            'Informe a área do imóvel para calcular a avaliação.'
        });
    }

    const chaveCache = JSON.stringify({
      ...alvo,
      links: urlsFornecidas(alvo)
    });

    const cache = cacheGet(
      chaveCache
    );

    if (cache) {
      return res.json({
        ...cache,
        cache: true
      });
    }

    let comparaveis =
      await coletarComparaveis(
        alvo
      );

    comparaveis =
      limparComparaveisDuplicados(
        comparaveis
      );

    comparaveis =
      ordenarComparaveis(
        comparaveis
      );

    comparaveis =
      comparaveis.slice(
        0,
        MAX_COMPARAVEIS
      );

    const avaliacao =
      calcularAvaliacao(
        comparaveis,
        alvo.area
      );

    const resposta = {
      sucesso: true,

      versao:
        'PRECISAO-V13-MP-SUPABASE',

      imovel: alvo,

      termo_busca:
        montarTermoBusca(
          alvo
        ),

      comparaveis_encontrados:
        comparaveis.length,

      minimo_recomendado:
        MIN_COMPARAVEIS,

      avaliacao,

      valores: {
        conservador:
          avaliacao.valor_conservador,

        mercado:
          avaliacao.valor_mercado,

        otimista:
          avaliacao.valor_otimista,

        conservador_formatado:
          moeda(
            avaliacao.valor_conservador
          ),

        mercado_formatado:
          moeda(
            avaliacao.valor_mercado
          ),

        otimista_formatado:
          moeda(
            avaliacao.valor_otimista
          )
      },

      comparaveis:
        comparaveis.map(
          item => ({
            titulo: item.titulo,
            url: item.url,
            dominio: item.dominio,
            preco: item.preco,

            preco_formatado:
              moeda(item.preco),

            area: item.area,

            valor_m2:
              Math.round(
                item.valor_m2
              ),

            quartos: item.quartos,
            suites: item.suites,
            banheiros: item.banheiros,
            vagas: item.vagas,
            score: item.score,
            similaridade:
              item.similaridade
          })
        ),

      aviso:
        comparaveis.length <
        MIN_COMPARAVEIS
          ? `Foram encontrados apenas ${comparaveis.length} comparáveis válidos. Para maior precisão, utilize pelo menos ${MIN_COMPARAVEIS}.`
          : null,

      gerado_em:
        new Date().toISOString()
    };

    cacheSet(
      chaveCache,
      resposta
    );

    return res.json(
      resposta
    );
  } catch (erro) {
    console.error(
      'Erro AYRO ACM:',
      erro
    );

    return res
      .status(500)
      .json({
        erro:
          'Erro interno na avaliação.',

        detalhe:
          erro.message ||
          String(erro),

        versao:
          'PRECISAO-V13-MP-SUPABASE'
      });
  }
});

/* ==========================================
   SUPABASE
========================================== */

const SUPABASE_URL =
  String(
    process.env.SUPABASE_URL ||
    ''
  ).replace(/\/$/, '');

/*
  IMPORTANTE:
  No seu Render a variável está cadastrada
  como SUPABASE_SECRET_KEY.

  As outras duas opções ficam como fallback.
*/

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

function supabaseConfigurado() {
  return Boolean(
    SUPABASE_URL &&
    SUPABASE_SERVICE_ROLE_KEY
  );
}

async function supabaseRequest(
  path,
  options = {}
) {
  if (!supabaseConfigurado()) {
    throw new Error(
      'SUPABASE_URL ou SUPABASE_SECRET_KEY não configurado no Render.'
    );
  }

  const resposta = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey:
          SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

        'Content-Type':
          'application/json',

        Prefer:
          options.prefer ||
          'return=representation',

        ...(options.headers || {})
      }
    }
  );

  const texto =
    await resposta.text();

  let dados = null;

  if (texto) {
    try {
      dados = JSON.parse(texto);
    } catch {
      dados = texto;
    }
  }

  if (!resposta.ok) {
    const erro = new Error(
      `Supabase HTTP ${resposta.status}`
    );

    erro.status =
      resposta.status;

    erro.dados =
      dados;

    throw erro;
  }

  return dados;
}

async function buscarProfilePorEmail(email) {
  if (!email) return null;

  try {
    const dados =
      await supabaseRequest(
        `profiles?email=eq.${encodeURIComponent(
          email
        )}&select=*`,
        {
          method: 'GET'
        }
      );

    return Array.isArray(dados)
      ? dados[0] || null
      : null;
  } catch (erro) {
    console.error(
      'Não foi possível localizar profile por e-mail:',
      erro.dados ||
      erro.message
    );

    return null;
  }
}

async function buscarAssinaturaPorEmail(email) {
  if (!email) return null;

  const dados =
    await supabaseRequest(
      `ayro_assinaturas?email=eq.${encodeURIComponent(
        email
      )}&select=*&order=created_at.desc&limit=1`,
      {
        method: 'GET'
      }
    );

  return Array.isArray(dados)
    ? dados[0] || null
    : null;
}

async function buscarAssinaturaPorMpId(mpId) {
  if (!mpId) return null;

  const dados =
    await supabaseRequest(
      `ayro_assinaturas?mercado_pago_subscription_id=eq.${encodeURIComponent(
        mpId
      )}&select=*&limit=1`,
      {
        method: 'GET'
      }
    );

  return Array.isArray(dados)
    ? dados[0] || null
    : null;
}

async function salvarAssinaturaSupabase(dados) {
  const email = String(
    dados.email ||
    ''
  )
    .trim()
    .toLowerCase();

  const mpId = String(
    dados.mercado_pago_subscription_id ||
    ''
  ).trim();

  let existente = null;

  if (mpId) {
    existente =
      await buscarAssinaturaPorMpId(
        mpId
      );
  }

  if (!existente && email) {
    existente =
      await buscarAssinaturaPorEmail(
        email
      );
  }

  const payload = {
    email:
      email ||
      existente?.email ||
      null,

    plano:
      dados.plano ||
      existente?.plano ||
      'AYRO ACM Pro',

    status:
      dados.status ||
      existente?.status ||
      'pending',

    mercado_pago_subscription_id:
      mpId ||
      existente
        ?.mercado_pago_subscription_id ||
      null,

    mercado_pago_payment_id:
      dados.mercado_pago_payment_id ||
      existente
        ?.mercado_pago_payment_id ||
      null,

    external_reference:
      dados.external_reference ||
      existente
        ?.external_reference ||
      null,

    valor:
      Number.isFinite(
        numero(dados.valor)
      )
        ? numero(dados.valor)
        : existente?.valor ||
          49.90,

    acesso_inicio:
      dados.acesso_inicio ||
      existente?.acesso_inicio ||
      null,

    acesso_fim:
      dados.acesso_fim ||
      existente?.acesso_fim ||
      null,

    proximo_pagamento:
      dados.proximo_pagamento ||
      existente?.proximo_pagamento ||
      null
  };

  if (
    dados.user_id ||
    existente?.user_id
  ) {
    payload.user_id =
      dados.user_id ||
      existente.user_id;
  } else if (email) {
    const profile =
      await buscarProfilePorEmail(
        email
      );

    if (profile?.id) {
      payload.user_id =
        profile.id;
    } else if (
      profile?.user_id
    ) {
      payload.user_id =
        profile.user_id;
    }
  }

  if (existente?.id) {
    const retorno =
      await supabaseRequest(
        `ayro_assinaturas?id=eq.${encodeURIComponent(
          existente.id
        )}`,
        {
          method: 'PATCH',

          body:
            JSON.stringify(
              payload
            )
        }
      );

    return Array.isArray(retorno)
      ? retorno[0] ||
          payload
      : payload;
  }

  const retorno =
    await supabaseRequest(
      'ayro_assinaturas',
      {
        method: 'POST',

        body:
          JSON.stringify(
            payload
          )
      }
    );

  return Array.isArray(retorno)
    ? retorno[0] ||
        payload
    : payload;
}/* ==========================================
   MERCADO PAGO - AYRO ACM PRO
========================================== */

const mpAccessToken = () =>
  process.env.MP_ACCESS_TOKEN || '';

const mpWebhookSecret = () =>
  process.env.MP_WEBHOOK_SECRET || '';

async function mpGet(path) {
  const token = mpAccessToken();

  if (!token) {
    throw new Error(
      'MP_ACCESS_TOKEN não configurado no servidor.'
    );
  }

  const resposta = await fetch(
    `https://api.mercadopago.com${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  const dados = await resposta
    .json()
    .catch(() => ({}));

  if (!resposta.ok) {
    const erro = new Error(
      `Mercado Pago HTTP ${resposta.status}`
    );

    erro.dados = dados;

    throw erro;
  }

  return dados;
}

function statusAtivoMercadoPago(status) {
  return [
    'authorized',
    'approved'
  ].includes(
    String(status || '').toLowerCase()
  );
}

function statusBloqueadoMercadoPago(status) {
  return [
    'cancelled',
    'canceled',
    'paused',
    'expired',
    'rejected'
  ].includes(
    String(status || '').toLowerCase()
  );
}

function statusInternoMercadoPago(status) {
  const s = String(status || '')
    .toLowerCase();

  if (statusAtivoMercadoPago(s)) {
    return 'active';
  }

  if (statusBloqueadoMercadoPago(s)) {
    return 'inactive';
  }

  return s || 'pending';
}

function dataIso(valor) {
  if (!valor) return null;

  const data = new Date(valor);

  if (
    Number.isNaN(
      data.getTime()
    )
  ) {
    return null;
  }

  return data.toISOString();
}

function adicionarMes(dataBase) {
  const data = dataBase
    ? new Date(dataBase)
    : new Date();

  if (
    Number.isNaN(
      data.getTime()
    )
  ) {
    return null;
  }

  data.setMonth(
    data.getMonth() + 1
  );

  return data.toISOString();
}

async function sincronizarAssinaturaMercadoPago(
  assinatura,
  extras = {}
) {
  if (!assinatura) return null;

  const email = String(
    assinatura.payer_email ||
    extras.email ||
    ''
  )
    .trim()
    .toLowerCase();

  const statusMp = String(
    assinatura.status ||
    extras.status ||
    'pending'
  )
    .trim()
    .toLowerCase();

  const ativo =
    statusAtivoMercadoPago(
      statusMp
    );

  const inicio = ativo
    ? (
        dataIso(
          assinatura.date_created
        ) ||
        dataIso(
          extras.acesso_inicio
        ) ||
        new Date().toISOString()
      )
    : (
        dataIso(
          extras.acesso_inicio
        ) ||
        null
      );

  const proximoPagamento =
    dataIso(
      assinatura.next_payment_date
    ) ||
    dataIso(
      extras.proximo_pagamento
    ) ||
    null;

  let acessoFim = null;

  if (ativo) {
    acessoFim =
      proximoPagamento ||
      adicionarMes(inicio);
  } else if (
    statusBloqueadoMercadoPago(
      statusMp
    )
  ) {
    acessoFim =
      new Date().toISOString();
  }

  const valor =
    numero(
      assinatura
        ?.auto_recurring
        ?.transaction_amount
    ) ||
    numero(
      extras.valor
    ) ||
    49.90;

  const registro =
    await salvarAssinaturaSupabase({
      email,

      plano:
        'AYRO ACM Pro',

      status:
        statusInternoMercadoPago(
          statusMp
        ),

      mercado_pago_subscription_id:
        assinatura.id ||
        extras.mercado_pago_subscription_id ||
        null,

      mercado_pago_payment_id:
        extras.mercado_pago_payment_id ||
        null,

      external_reference:
        assinatura.external_reference ||
        extras.external_reference ||
        null,

      valor,

      acesso_inicio:
        inicio,

      acesso_fim:
        acessoFim,

      proximo_pagamento:
        proximoPagamento
    });

  console.log(
    'AYRO assinatura sincronizada:',
    {
      email,
      mp_status: statusMp,
      status:
        statusInternoMercadoPago(
          statusMp
        ),
      assinatura_id:
        assinatura.id
    }
  );

  return registro;
}

/* ==========================================
   CRIAR ASSINATURA
========================================== */

app.post(
  '/api/mercadopago/criar-assinatura',
  async (req, res) => {
    try {
      const accessToken =
        mpAccessToken();

      if (!accessToken) {
        return res
          .status(500)
          .json({
            erro:
              'MP_ACCESS_TOKEN não configurado no servidor.'
          });
      }

      const email = String(
        req.body?.email ||
        ''
      )
        .trim()
        .toLowerCase();

      if (!email) {
        return res
          .status(400)
          .json({
            erro:
              'Informe o e-mail do cliente.'
          });
      }

      const baseUrl =
        process.env.APP_BASE_URL ||
        'https://ayro-acm.onrender.com';

      const externalReference =
        `AYRO-${Date.now()}`;

      const assinatura = {
        reason:
          'AYRO ACM Pro',

        external_reference:
          externalReference,

        payer_email:
          email,

        auto_recurring: {
          frequency: 1,

          frequency_type:
            'months',

          transaction_amount:
            49.90,

          currency_id:
            'BRL'
        },

        back_url:
          baseUrl,

        status:
          'pending'
      };

      const resposta = await fetch(
        'https://api.mercadopago.com/preapproval',
        {
          method: 'POST',

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            'Content-Type':
              'application/json'
          },

          body:
            JSON.stringify(
              assinatura
            )
        }
      );

      const dados = await resposta
        .json()
        .catch(() => ({}));

      if (!resposta.ok) {
        console.error(
          'Erro Mercado Pago:',
          dados
        );

        return res
          .status(resposta.status)
          .json({
            erro:
              'Não foi possível criar a assinatura.',

            detalhes:
              dados
          });
      }

      try {
        await salvarAssinaturaSupabase({
          email,

          plano:
            'AYRO ACM Pro',

          status:
            statusInternoMercadoPago(
              dados.status ||
              'pending'
            ),

          mercado_pago_subscription_id:
            dados.id,

          external_reference:
            dados.external_reference ||
            externalReference,

          valor:
            49.90,

          acesso_inicio:
            null,

          acesso_fim:
            null,

          proximo_pagamento:
            dataIso(
              dados.next_payment_date
            )
        });
      } catch (erroSupabase) {
        console.error(
          'Assinatura criada no Mercado Pago, mas houve erro ao registrar no Supabase:',
          erroSupabase.dados ||
          erroSupabase.message
        );
      }

      return res.json({
        sucesso: true,

        assinatura_id:
          dados.id,

        status:
          dados.status,

        checkout_url:
          dados.init_point,

        external_reference:
          dados.external_reference ||
          externalReference
      });
    } catch (erro) {
      console.error(
        'Erro ao criar assinatura Mercado Pago:',
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Erro interno ao criar assinatura.'
        });
    }
  }
);

/* ==========================================
   CONSULTAR ASSINATURA
========================================== */

app.get(
  '/api/mercadopago/assinatura/:id',
  async (req, res) => {
    try {
      const id = String(
        req.params.id ||
        ''
      ).trim();

      if (!id) {
        return res
          .status(400)
          .json({
            erro:
              'ID da assinatura não informado.'
          });
      }

      const dados = await mpGet(
        `/preapproval/${encodeURIComponent(
          id
        )}`
      );

      return res.json({
        sucesso: true,

        id:
          dados.id,

        status:
          dados.status,

        acesso_ativo:
          statusAtivoMercadoPago(
            dados.status
          ),

        payer_email:
          dados.payer_email,

        external_reference:
          dados.external_reference,

        next_payment_date:
          dados.next_payment_date ||
          null
      });
    } catch (erro) {
      console.error(
        'Erro ao consultar assinatura Mercado Pago:',
        erro.dados ||
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível consultar a assinatura.'
        });
    }
  }
);

/* ==========================================
   CONSULTAR ACESSO DO CLIENTE
========================================== */

app.get(
  '/api/acesso',
  async (req, res) => {
    try {
      const email = String(
        req.query.email ||
        ''
      )
        .trim()
        .toLowerCase();

      if (!email) {
        return res
          .status(400)
          .json({
            erro:
              'Informe o e-mail.'
          });
      }

      const assinatura =
        await buscarAssinaturaPorEmail(
          email
        );

      if (!assinatura) {
        return res.json({
          sucesso: true,
          email,
          acesso: false,
          status:
            'sem_assinatura'
        });
      }

      const status = String(
        assinatura.status ||
        ''
      ).toLowerCase();

      const ativo =
        status === 'active' ||
        status === 'authorized' ||
        status === 'approved';

      let dentroDaValidade =
        true;

      if (
        assinatura.acesso_fim
      ) {
        const fim = new Date(
          assinatura.acesso_fim
        );

        if (
          !Number.isNaN(
            fim.getTime()
          )
        ) {
          dentroDaValidade =
            fim.getTime() >
            Date.now();
        }
      }

      return res.json({
        sucesso: true,
        email,

        acesso:
          ativo &&
          dentroDaValidade,

        status:
          assinatura.status,

        plano:
          assinatura.plano,

        acesso_inicio:
          assinatura.acesso_inicio,

        acesso_fim:
          assinatura.acesso_fim,

        proximo_pagamento:
          assinatura.proximo_pagamento,

        mercado_pago_subscription_id:
          assinatura
            .mercado_pago_subscription_id
      });
    } catch (erro) {
      console.error(
        'Erro ao consultar acesso:',
        erro.dados ||
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível consultar o acesso do cliente.'
        });
    }
  }
);

/* ==========================================
   VALIDAR ASSINATURA DO WEBHOOK
========================================== */

function webhookAssinaturaValida(req) {
  const secret =
    mpWebhookSecret();

  if (!secret) {
    console.error(
      'MP_WEBHOOK_SECRET não configurado.'
    );

    return false;
  }

  const xSignature = String(
    req.headers['x-signature'] ||
    ''
  );

  const xRequestId = String(
    req.headers['x-request-id'] ||
    ''
  );

  if (
    !xSignature ||
    !xRequestId
  ) {
    return false;
  }

  const partes = {};

  for (
    const parte of
    xSignature.split(',')
  ) {
    const [
      chave,
      ...resto
    ] = parte
      .trim()
      .split('=');

    if (
      chave &&
      resto.length
    ) {
      partes[chave] =
        resto.join('=');
    }
  }

  const ts =
    partes.ts;

  const recebido =
    partes.v1;

  if (
    !ts ||
    !recebido
  ) {
    return false;
  }

  const dataId = String(
    req.query?.['data.id'] ||
    req.query?.id ||
    req.body?.data?.id ||
    req.body?.id ||
    ''
  ).toLowerCase();

  const manifest =
    `id:${dataId};request-id:${xRequestId};ts:${ts};`;

  const esperado = crypto
    .createHmac(
      'sha256',
      secret
    )
    .update(manifest)
    .digest('hex');

  try {
    const a = Buffer.from(
      esperado,
      'utf8'
    );

    const b = Buffer.from(
      recebido,
      'utf8'
    );

    if (
      a.length !==
      b.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      a,
      b
    );
  } catch {
    return false;
  }
}

/* ==========================================
   PROCESSAR PAGAMENTO
========================================== */

async function processarPagamento(
  pagamento
) {
  if (!pagamento) return;

  const status = String(
    pagamento.status ||
    ''
  ).toLowerCase();

  const email = String(
    pagamento?.payer?.email ||
    pagamento
      ?.additional_info
      ?.payer
      ?.email ||
    ''
  )
    .trim()
    .toLowerCase();

  const externalReference =
    pagamento.external_reference ||
    null;

  const subscriptionId =
    pagamento
      ?.metadata
      ?.preapproval_id ||
    pagamento
      ?.metadata
      ?.subscription_id ||
    null;

  if (subscriptionId) {
    try {
      const assinatura =
        await mpGet(
          `/preapproval/${encodeURIComponent(
            subscriptionId
          )}`
        );

      await sincronizarAssinaturaMercadoPago(
        assinatura,
        {
          email,

          mercado_pago_payment_id:
            pagamento.id,

          external_reference:
            externalReference,

          valor:
            pagamento.transaction_amount
        }
      );

      return;
    } catch (erro) {
      console.error(
        'Erro ao consultar assinatura ligada ao pagamento:',
        erro.dados ||
        erro
      );
    }
  }

  if (!email) {
    console.log(
      'Pagamento recebido sem e-mail identificável:',
      pagamento.id
    );

    return;
  }

  const existente =
    await buscarAssinaturaPorEmail(
      email
    );

  let statusInterno =
    existente?.status ||
    'pending';

  let acessoInicio =
    existente?.acesso_inicio ||
    null;

  let acessoFim =
    existente?.acesso_fim ||
    null;

  if (
    status === 'approved'
  ) {
    statusInterno =
      'active';

    acessoInicio =
      acessoInicio ||
      new Date().toISOString();

    acessoFim =
      adicionarMes(
        new Date()
      );
  }

  if (
    [
      'rejected',
      'cancelled',
      'canceled',
      'refunded',
      'charged_back'
    ].includes(status)
  ) {
    statusInterno =
      'inactive';

    acessoFim =
      new Date().toISOString();
  }

  await salvarAssinaturaSupabase({
    email,

    plano:
      'AYRO ACM Pro',

    status:
      statusInterno,

    mercado_pago_subscription_id:
      existente
        ?.mercado_pago_subscription_id ||
      null,

    mercado_pago_payment_id:
      pagamento.id,

    external_reference:
      externalReference ||
      existente
        ?.external_reference ||
      null,

    valor:
      pagamento.transaction_amount,

    acesso_inicio:
      acessoInicio,

    acesso_fim:
      acessoFim,

    proximo_pagamento:
      existente
        ?.proximo_pagamento ||
      null
  });
}

/* ==========================================
   WEBHOOK MERCADO PAGO
========================================== */

app.post(
  '/api/mercadopago/webhook',
  async (req, res) => {
    if (
      !webhookAssinaturaValida(
        req
      )
    ) {
      console.error(
        'Webhook Mercado Pago com assinatura inválida.'
      );

      return res
        .status(401)
        .json({
          erro:
            'Assinatura do webhook inválida.'
        });
    }

    res.sendStatus(200);

    try {
      const body =
        req.body ||
        {};

      const tipo = String(
        body.type ||
        body.topic ||
        req.query.type ||
        req.query.topic ||
        ''
      ).trim();

      const dataId = String(
        body?.data?.id ||
        body.id ||
        req.query?.['data.id'] ||
        req.query?.id ||
        ''
      ).trim();

      if (!dataId) {
        console.log(
          'Webhook Mercado Pago recebido sem data.id:',
          body
        );

        return;
      }

      console.log(
        'Webhook Mercado Pago:',
        {
          tipo,
          dataId
        }
      );

      if (
        tipo ===
          'subscription_preapproval' ||
        tipo ===
          'preapproval'
      ) {
        const assinatura =
          await mpGet(
            `/preapproval/${encodeURIComponent(
              dataId
            )}`
          );

        await sincronizarAssinaturaMercadoPago(
          assinatura
        );

        return;
      }

      if (
        tipo === 'payment'
      ) {
        const pagamento =
          await mpGet(
            `/v1/payments/${encodeURIComponent(
              dataId
            )}`
          );

        await processarPagamento(
          pagamento
        );

        return;
      }

      if (
        tipo ===
        'subscription_authorized_payment'
      ) {
        const fatura =
          await mpGet(
            `/authorized_payments/${encodeURIComponent(
              dataId
            )}`
          );

        const preapprovalId =
          fatura.preapproval_id;

        if (preapprovalId) {
          const assinatura =
            await mpGet(
              `/preapproval/${encodeURIComponent(
                preapprovalId
              )}`
            );

          await sincronizarAssinaturaMercadoPago(
            assinatura,
            {
              mercado_pago_payment_id:
                fatura.payment?.id ||
                fatura.id,

              valor:
                fatura.transaction_amount
            }
          );
        }

        return;
      }

      console.log(
        'Webhook Mercado Pago - evento não tratado:',
        tipo,
        dataId
      );
    } catch (erro) {
      console.error(
        'Erro ao processar webhook Mercado Pago:',
        erro.dados ||
        erro
      );
    }
  }
);

/* ==========================================
   SINCRONIZAÇÃO MANUAL
========================================== */

app.post(
  '/api/mercadopago/sincronizar/:id',
  async (req, res) => {
    try {
      const id = String(
        req.params.id ||
        ''
      ).trim();

      if (!id) {
        return res
          .status(400)
          .json({
            erro:
              'Informe o ID da assinatura.'
          });
      }

      const assinatura =
        await mpGet(
          `/preapproval/${encodeURIComponent(
            id
          )}`
        );

      const registro =
        await sincronizarAssinaturaMercadoPago(
          assinatura
        );

      return res.json({
        sucesso: true,

        mercado_pago: {
          id:
            assinatura.id,

          status:
            assinatura.status,

          email:
            assinatura.payer_email
        },

        supabase:
          registro
      });
    } catch (erro) {
      console.error(
        'Erro na sincronização manual:',
        erro.dados ||
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível sincronizar a assinatura.',

          detalhe:
            erro.dados ||
            erro.message
        });
    }
  }
);

/* ==========================================
   STATUS DAS INTEGRAÇÕES
========================================== */

app.get(
  '/api/status-integracoes',
  (req, res) => {
    res.json({
      sucesso: true,

      mercado_pago: {
        access_token:
          Boolean(
            mpAccessToken()
          ),

        webhook_secret:
          Boolean(
            mpWebhookSecret()
          )
      },

      supabase: {
        url:
          Boolean(
            SUPABASE_URL
          ),

        secret_key:
          Boolean(
            SUPABASE_SERVICE_ROLE_KEY
          )
      },

      versao:
        'PRECISAO-V13-MP-SUPABASE'
    });
  }
);

/* ==========================================
   ROTA NÃO ENCONTRADA
========================================== */

app.use(
  (req, res) => {
    return res
      .status(404)
      .json({
        erro:
          'Rota não encontrada.',

        metodo:
          req.method,

        rota:
          req.originalUrl
      });
  }
);

/* ==========================================
   TRATAMENTO GLOBAL DE ERROS
========================================== */

app.use(
  (
    erro,
    req,
    res,
    next
  ) => {
    console.error(
      'Erro não tratado:',
      erro
    );

    if (
      res.headersSent
    ) {
      return next(erro);
    }

    return res
      .status(500)
      .json({
        erro:
          'Erro interno do servidor.'
      });
  }
);

/* ==========================================
   INICIALIZAÇÃO
========================================== */

const PORT =
  process.env.PORT ||
  3000;

if (
  require.main === module
) {
  app.listen(
    PORT,
    () => {
      console.log(
        `AYRO ACM API PRECISAO-V13-MP-SUPABASE rodando na porta ${PORT}`
      );

      console.log(
        'Mercado Pago:',
        mpAccessToken()
          ? 'MP_ACCESS_TOKEN OK'
          : 'MP_ACCESS_TOKEN AUSENTE'
      );

      console.log(
        'Webhook:',
        mpWebhookSecret()
          ? 'MP_WEBHOOK_SECRET OK'
          : 'MP_WEBHOOK_SECRET AUSENTE'
      );

      console.log(
        'Supabase:',
        supabaseConfigurado()
          ? 'SUPABASE_SECRET_KEY OK'
          : 'CONFIGURAÇÃO INCOMPLETA'
      );
    }
  );
}

module.exports = {
  app,
  dadosDaBusca,
  dadosDaUrl,
  ehLinkIndividual,
  extrairDaPagina,
  avaliarItem,
  calcularAvaliacao
};
