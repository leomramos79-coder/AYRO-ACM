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

function numeroBR(v) {
  if (v == null || v === '') return null;

  let s = String(v)
    .trim()
    .replace(/\s/g, '')
    .replace(/^R\$/i, '')
    .replace(/[^0-9.,]/g, '');

  if (!s) return null;

  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }

  const n = Number(s);

  return Number.isFinite(n) ? n : null;
}

function mediana(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);

  if (!v.length) return null;

  const m = Math.floor(v.length / 2);

  return v.length % 2
    ? v[m]
    : (v[m - 1] + v[m]) / 2;
}

function media(a) {
  const v = a.filter(Number.isFinite);

  return v.length
    ? v.reduce((x, y) => x + y, 0) / v.length
    : null;
}

function normalizarLink(link = '') {
  try {
    const u = new URL(link);

    [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
      'relatedAds'
    ].forEach(k => u.searchParams.delete(k));

    return (u.origin + u.pathname).replace(/\/$/, '');
  } catch {
    return String(link)
      .split('?')[0]
      .replace(/\/$/, '');
  }
}

function dadosDaBusca(q, params = {}) {
  const nq = norm(q);

  const tipo =
    norm(params.tipo) ||
    (
      /apartamento|\bapto\b|flat|studio/.test(nq)
        ? 'apartamento'
        : /\bcasa\b|sobrado/.test(nq)
          ? 'casa'
          : ''
    );

  const qm = nq.match(
    /(\d+)\s*(?:quartos?|dormitorios?|dorms?|qtos?)/i
  );

  const am = nq.match(
    /(\d+(?:[.,]\d+)?)\s*m(?:²|2)(?![a-z0-9])/i
  );

  const num = v => {
    const n = numeroBR(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    tipo,

    cidade: String(params.cidade || '').trim(),

    bairro: String(params.bairro || '').trim(),

    quartos:
      num(params.quartos) ??
      (qm ? Number(qm[1]) : null),

    suites: num(params.suites),

    vagas: num(params.vagas),

    area:
      num(params.area) ??
      (am ? numeroBR(am[1]) : null),

    condominio: num(params.condominio),

    conservacao:
      String(params.conservacao || '').trim(),

    piscina:
      String(params.piscina || '').toLowerCase() === 'sim',

    sauna:
      String(params.sauna || '').toLowerCase() === 'sim',

    diferenciais:
      String(params.diferenciais || '').trim()
  };
}

function dadosDaUrl(link = '') {
  let s = '';

  try {
    s = decodeURIComponent(
      String(link || '')
    ).toLowerCase();
  } catch {
    s = String(link || '').toLowerCase();
  }

  const q = s.match(
    /(?:-|\/)(\d+)-quartos?(?:-|\/)/i
  );

  const a = s.match(
    /(?:-|\/)(\d+(?:[.,]\d+)?)(?:m2|m²)(?:-|\/)/i
  );

  const p = s.match(
    /(?:-|\/)(?:rs|r\$)(\d{5,9})(?:\/|\?|$)/i
  );

  return {
    quartos: q ? Number(q[1]) : null,
    area: a ? numeroBR(a[1]) : null,
    preco: p ? numeroBR(p[1]) : null
  };
}

function ehLinkIndividual(link = '') {
  const l = String(link || '').toLowerCase();

  if (!l) return false;

  if (
    /chavesnamao\.com\.br\/imovel\//i.test(l) &&
    /\/id-\d+/i.test(l)
  ) {
    return true;
  }

  if (
    /imovelweb\.com\.br\/propriedades\//i.test(l)
  ) {
    return true;
  }

  if (
    /(?:zapimoveis|vivareal)\.com\.br\/imovel\//i.test(l)
  ) {
    return true;
  }

  if (
    /\/(?:imovel|imoveis|property|properties)\//i.test(l) &&
    !/\/(?:busca|search)\/?(?:\?|$)/i.test(l)
  ) {
    return true;
  }

  return false;
}

function precosNoTexto(texto) {
  const out = [];

  const encontrados =
    String(texto).match(
      /R\$\s*[0-9]{2,3}(?:[.\s][0-9]{3})*(?:,[0-9]{2})?|R\$\s*[0-9]{5,9}/gi
    ) || [];

  for (const m of encontrados) {
    const n = numeroBR(m);

    if (
      Number.isFinite(n) &&
      n >= 50000 &&
      n <= 100000000
    ) {
      out.push(n);
    }
  }

  return [...new Set(out)];
}

function areasNoTexto(texto) {
  const out = [];

  for (
    const m of String(texto).matchAll(
      /(\d+(?:[.,]\d+)?)\s*m(?:²|2)(?![a-z0-9])/gi
    )
  ) {
    const n = numeroBR(m[1]);

    if (
      Number.isFinite(n) &&
      n >= 15 &&
      n <= 100000
    ) {
      out.push(n);
    }
  }

  return [...new Set(out)];
}

function quartosNoTexto(texto) {
  return [
    ...new Set(
      [
        ...norm(texto).matchAll(
          /(\d+)\s*(?:quartos?|dormitorios?|dorms?|qtos?)/g
        )
      ]
        .map(m => Number(m[1]))
        .filter(n => n > 0 && n < 30)
    )
  ];
}

function primeiroNumero(texto, re, min = 0, max = 999999) {
  const m = norm(texto).match(re);

  if (!m) return null;

  const n = numeroBR(m[1]);

  return (
    Number.isFinite(n) &&
    n >= min &&
    n <= max
  )
    ? n
    : null;
}

function extrairAtributos(texto = '') {
  const t = norm(texto);

  const suites = primeiroNumero(
    t,
    /(\d+)\s*(?:suites?|suite)/,
    0,
    20
  );

  const vagas = primeiroNumero(
    t,
    /(\d+)\s*(?:vagas?|garagens?)/,
    0,
    30
  );

  const condo = primeiroNumero(
    t,
    /(?:condominio|cond)[^0-9]{0,15}(?:r\$)?\s*([0-9.]+(?:,[0-9]{1,2})?)/,
    0,
    100000
  );

  const piscina = /\bpiscina\b/.test(t);
  const sauna = /\bsauna\b/.test(t);

  let conservacao = '';

  if (/novo|lancamento|primeira locacao/.test(t)) {
    conservacao = 'novo';
  } else if (/reformad[oa]|renovad[oa]/.test(t)) {
    conservacao = 'reformado';
  } else if (/bom estado|bem conservad[oa]/.test(t)) {
    conservacao = 'bom estado';
  } else if (/para reformar|precisa reform/.test(t)) {
    conservacao = 'para reformar';
  } else if (/usad[oa]/.test(t)) {
    conservacao = 'usado';
  }

  return {
    suites,
    vagas,
    condominio: condo,
    piscina,
    sauna,
    conservacao
  };
}

function contemTermo(texto, termo) {
  const a = norm(texto);
  const b = norm(termo).trim();

  return !!b && a.includes(b);
}

function scoreProximidadeNumero(alvo, valor, peso, tol) {
  if (
    !Number.isFinite(alvo) ||
    !Number.isFinite(valor)
  ) {
    return 0;
  }

  const d =
    Math.abs(valor - alvo) /
    Math.max(Math.abs(alvo), 1);

  return Math.max(
    0,
    peso * (1 - d / tol)
  );
}

function escolherArea(vals, alvo) {
  if (!vals.length) return null;

  return Number.isFinite(alvo)
    ? [...vals].sort(
        (a, b) =>
          Math.abs(a - alvo) -
          Math.abs(b - alvo)
      )[0]
    : vals[0];
}

function extrairJsonLd(html) {
  const dados = [];

  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let m;

  while ((m = re.exec(html))) {
    try {
      const x = JSON.parse(m[1].trim());

      dados.push(
        ...(Array.isArray(x) ? x : [x])
      );
    } catch {}
  }

  return dados;
}

function caminhar(obj, fn, depth = 0) {
  if (
    obj == null ||
    depth > 7
  ) {
    return;
  }

  if (Array.isArray(obj)) {
    obj.forEach(
      x => caminhar(
        x,
        fn,
        depth + 1
      )
    );

    return;
  }

  if (typeof obj === 'object') {
    fn(obj);

    Object.values(obj).forEach(
      x => caminhar(
        x,
        fn,
        depth + 1
      )
    );
  }
}

function extrairDaPagina(html, busca) {
  const clean =
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&sup2;|&#178;/gi, '²')
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ');

  const precos = precosNoTexto(clean);
  const areas = areasNoTexto(clean);
  const quartos = quartosNoTexto(clean);

  const structured = {
    precos: [],
    areas: [],
    quartos: []
  };

  for (const root of extrairJsonLd(html)) {
    caminhar(
      root,
      o => {
        for (const [k, v] of Object.entries(o)) {
          if (/^(price|lowPrice|highPrice)$/i.test(k)) {
            const n = numeroBR(v);

            if (
              Number.isFinite(n) &&
              n >= 50000
            ) {
              structured.precos.push(n);
            }
          }

          if (/floorSize|area|size/i.test(k)) {
            const val =
              typeof v === 'object'
                ? (v.value || v.amount || '')
                : v;

            const n = numeroBR(val);

            if (
              Number.isFinite(n) &&
              n >= 15 &&
              n <= 100000
            ) {
              structured.areas.push(n);
            }
          }

          if (
            /numberOfRooms|numberOfBedrooms|bedrooms/i.test(k)
          ) {
            const n = Number(v);

            if (
              Number.isFinite(n) &&
              n > 0 &&
              n < 30
            ) {
              structured.quartos.push(n);
            }
          }
        }
      }
    );
  }

  const metaPrice = [
    ...String(html).matchAll(
      /(?:property|name)=["'][^"']*(?:price|preco)[^"']*["'][^>]*content=["']([^"']+)/gi
    )
  ]
    .map(m => numeroBR(m[1]))
    .filter(
      n =>
        Number.isFinite(n) &&
        n >= 50000
    );

  const allPrecos = [
    ...new Set([
      ...structured.precos,
      ...metaPrice,
      ...precos
    ])
  ];

  const allAreas = [
    ...new Set([
      ...structured.areas,
      ...areas
    ])
  ];

  const allQuartos = [
    ...new Set([
      ...structured.quartos,
      ...quartos
    ])
  ];

  const attrs = extrairAtributos(clean);

  return {
    preco: allPrecos[0] || null,

    area: escolherArea(
      allAreas,
      busca.area
    ),

    quartos: allQuartos,

    ...attrs,

    texto: clean.slice(0, 20000)
  };
}async function enriquecerPagina(
  item,
  busca
) {
  if (!ehLinkIndividual(item.link)) {
    return item;
  }

  const ctrl = new AbortController();

  const timer = setTimeout(
    () => ctrl.abort(),
    FETCH_TIMEOUT_MS
  );

  try {
    const r = await fetch(
      item.link,
      {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': UA,
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.7',
          accept: 'text/html,application/xhtml+xml'
        }
      }
    );

    if (!r.ok) {
      return item;
    }

    const ct =
      r.headers.get('content-type') || '';

    if (!ct.includes('text/html')) {
      return item;
    }

    const html = await r.text();

    const p = extrairDaPagina(
      html,
      busca
    );

    return {
      ...item,
      _pagina: p
    };
  } catch {
    return item;
  } finally {
    clearTimeout(timer);
  }
}

function avaliarItem(
  item,
  busca
) {
  const titulo =
    item.title || '';

  const descricao =
    item.snippet || '';

  const link =
    item.link || '';

  const texto =
    `${titulo} ${descricao}`;

  const ud =
    dadosDaUrl(link);

  const pg =
    item._pagina || {};

  const full =
    `${texto} ${pg.texto || ''}`;

  const attrs =
    extrairAtributos(full);

  const precos = [
    ud.preco,
    pg.preco,
    ...precosNoTexto(texto)
  ].filter(Number.isFinite);

  const preco =
    precos[0] || null;

  const areas = [
    ud.area,
    pg.area,
    ...areasNoTexto(texto)
  ].filter(Number.isFinite);

  const area =
    escolherArea(
      [...new Set(areas)],
      busca.area
    );

  const quartos = [
    ud.quartos,
    ...(pg.quartos || []),
    ...quartosNoTexto(texto)
  ].filter(Number.isFinite);

  const suites =
    Number.isFinite(pg.suites)
      ? pg.suites
      : attrs.suites;

  const vagas =
    Number.isFinite(pg.vagas)
      ? pg.vagas
      : attrs.vagas;

  const condominio =
    Number.isFinite(pg.condominio)
      ? pg.condominio
      : attrs.condominio;

  const piscina =
    Boolean(
      pg.piscina ||
      attrs.piscina
    );

  const sauna =
    Boolean(
      pg.sauna ||
      attrs.sauna
    );

  const conservacao =
    pg.conservacao ||
    attrs.conservacao ||
    '';

  const motivos = [];

  if (!ehLinkIndividual(link)) {
    motivos.push(
      'link não é anúncio individual'
    );
  }

  if (!Number.isFinite(preco)) {
    motivos.push(
      'sem preço identificado'
    );
  }

  if (!Number.isFinite(area)) {
    motivos.push(
      'sem área identificada'
    );
  }

  const nt = norm(full);

  const temApto =
    /apartamento|\bapto\b|flat|studio/.test(nt);

  const temCasa =
    /\bcasa\b|sobrado/.test(nt);

  const tipoConfere =
    busca.tipo === 'apartamento'
      ? (!temCasa || temApto)
      : busca.tipo === 'casa'
        ? (!temApto || temCasa)
        : true;

  if (!tipoConfere) {
    motivos.push(
      'tipo de imóvel divergente'
    );
  }

  let diferencaArea = null;

  if (
    busca.area &&
    area
  ) {
    diferencaArea =
      Math.abs(
        area - busca.area
      ) /
      busca.area;

    if (
      diferencaArea >
      TOLERANCIA_AREA
    ) {
      motivos.push(
        'área fora da faixa'
      );
    }
  }

  const precoM2 =
    preco && area
      ? preco / area
      : null;

  let score = 0;

  const detalhes = {};

  const bairroOk =
    busca.bairro
      ? contemTermo(
          full,
          busca.bairro
        )
      : null;

  detalhes.bairro =
    bairroOk;

  if (bairroOk) {
    score += 25;
  }

  if (busca.tipo) {
    if (tipoConfere) {
      score += 15;
      detalhes.tipo = true;
    } else {
      detalhes.tipo = false;
    }
  } else {
    score += 15;
    detalhes.tipo = null;
  }

  if (
    Number.isFinite(
      diferencaArea
    )
  ) {
    const pts =
      Math.max(
        0,
        20 *
          (
            1 -
            diferencaArea /
              TOLERANCIA_AREA
          )
      );

    score += pts;

    detalhes.area =
      Math.round(pts);
  }

  let ptsQS = 0;

  if (
    busca.quartos &&
    quartos.includes(
      busca.quartos
    )
  ) {
    ptsQS += 6;
  }

  if (
    Number.isFinite(
      busca.suites
    ) &&
    Number.isFinite(
      suites
    ) &&
    busca.suites === suites
  ) {
    ptsQS += 4;
  }

  score += ptsQS;

  detalhes.quartos_suites =
    ptsQS;

  if (
    busca.conservacao &&
    conservacao &&
    norm(busca.conservacao)
      .includes(
        norm(conservacao)
      )
  ) {
    score += 8;
    detalhes.conservacao = true;
  } else {
    detalhes.conservacao = null;
  }

  if (
    Number.isFinite(
      busca.vagas
    ) &&
    Number.isFinite(
      vagas
    ) &&
    busca.vagas === vagas
  ) {
    score += 5;
    detalhes.vagas = true;
  } else {
    detalhes.vagas = null;
  }

  if (
    Number.isFinite(
      busca.condominio
    ) &&
    busca.condominio > 0 &&
    Number.isFinite(
      condominio
    )
  ) {
    const pts =
      scoreProximidadeNumero(
        busca.condominio,
        condominio,
        4,
        0.5
      );

    score += pts;

    detalhes.condominio =
      Math.round(pts);
  }

  let lazer = 0;

  if (
    busca.piscina === piscina
  ) {
    lazer += 1.5;
  }

  if (
    busca.sauna === sauna
  ) {
    lazer += 1.5;
  }

  score += lazer;

  detalhes.piscina_sauna =
    lazer;

  if (busca.diferenciais) {
    const termos =
      norm(busca.diferenciais)
        .split(/[,;]+/)
        .map(x => x.trim())
        .filter(x => x.length > 2);

    if (termos.length) {
      const acertos =
        termos.filter(
          t => nt.includes(t)
        ).length;

      const pts =
        3 *
        (
          acertos /
          termos.length
        );

      score += pts;

      detalhes.diferenciais =
        Math.round(
          pts * 10
        ) / 10;
    }
  }

  if (precoM2) {
    score += 2;
    detalhes.preco_m2 = 2;
  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  return {
    titulo,
    descricao,
    link,

    fonte:
      item.source ||
      item.displayed_link ||
      '',

    preco:
      Number.isFinite(preco)
        ? `R$ ${Math.round(preco)
            .toLocaleString('pt-BR')}`
        : '',

    area:
      Number.isFinite(area)
        ? `${String(area)
            .replace('.', ',')} m²`
        : '',

    preco_valor: preco,
    area_valor: area,
    preco_m2: precoM2,

    quartos_identificados:
      quartos[0] ?? null,

    suites_identificadas:
      suites,

    vagas_identificadas:
      vagas,

    condominio_identificado:
      condominio,

    piscina_identificada:
      piscina,

    sauna_identificada:
      sauna,

    conservacao_identificada:
      conservacao,

    score_similaridade:
      Math.round(score),

    comparavel_valido:
      motivos.length === 0,

    motivo_descarte:
      motivos.join('; '),

    diagnostico: {
      individual:
        ehLinkIndividual(link),

      dados_pagina:
        Boolean(item._pagina),

      diferencaArea,
      detalhes
    }
  };
}

async function buscarSerp(
  apiKey,
  q,
  num = 20
) {
  try {
    const params =
      new URLSearchParams({
        engine: 'google',
        q,
        hl: 'pt-br',
        gl: 'br',
        num: String(num),
        api_key: apiKey
      });

    const r =
      await fetch(
        `https://serpapi.com/search.json?${params}`
      );

    const d =
      await r.json();

    if (!r.ok) {
      return {
        resultados: [],
        erro:
          d.error ||
          `HTTP ${r.status}`,
        fatal:
          [401, 403, 429]
            .includes(r.status)
      };
    }

    if (d.error) {
      return {
        resultados: [],
        erro: String(d.error),

        fatal:
          /invalid api key|unauthorized|credits|account|rate limit/i
            .test(String(d.error))
      };
    }

    return {
      resultados:
        Array.isArray(
          d.organic_results
        )
          ? d.organic_results
          : [],

      erro: '',
      fatal: false
    };
  } catch (e) {
    return {
      resultados: [],
      erro:
        e.message ||
        String(e),
      fatal: false
    };
  }
}

function semOutliers(comps) {
  if (comps.length < 4) {
    return comps;
  }

  const v =
    comps
      .map(x => x.preco_m2)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

  if (v.length < 4) {
    return comps;
  }

  const q1 =
    v[
      Math.floor(
        (v.length - 1) * 0.25
      )
    ];

  const q3 =
    v[
      Math.floor(
        (v.length - 1) * 0.75
      )
    ];

  const iqr =
    q3 - q1;

  const min =
    q1 - 1.5 * iqr;

  const max =
    q3 + 1.5 * iqr;

  const f =
    comps.filter(
      x =>
        x.preco_m2 >= min &&
        x.preco_m2 <= max
    );

  return (
    f.length >=
    MIN_COMPARAVEIS
  )
    ? f
    : comps;
}

function calcularAvaliacao(
  comps,
  area
) {
  if (
    !area ||
    comps.length <
      MIN_COMPARAVEIS
  ) {
    return {
      calculada: false,

      motivo:
        !area
          ? 'Informe a área do imóvel na pesquisa para calcular a avaliação.'
          : `Foram encontrados apenas ${comps.length} comparáveis válidos. São necessários pelo menos ${MIN_COMPARAVEIS}.`
    };
  }

  const base =
    semOutliers(comps);

  const valid =
    base.filter(
      x =>
        Number.isFinite(
          x.preco_m2
        )
    );

  if (
    valid.length <
    MIN_COMPARAVEIS
  ) {
    return {
      calculada: false,

      motivo:
        'Não há comparáveis suficientes com preço por m² válido.'
    };
  }

  const fortes =
    valid.filter(
      x =>
        x.score_similaridade >=
        SIMILARIDADE_PREFERENCIAL
    );

  const usados =
    fortes.length >=
    MIN_COMPARAVEIS
      ? fortes
      : valid;

  const somaPeso =
    usados.reduce(
      (s, x) =>
        s +
        Math.max(
          1,
          x.score_similaridade
        ),
      0
    );

  const ponderado =
    usados.reduce(
      (s, x) =>
        s +
        x.preco_m2 *
          Math.max(
            1,
            x.score_similaridade
          ),
      0
    ) /
    somaPeso;

  const med =
    mediana(
      usados.map(
        x => x.preco_m2
      )
    );

  const avg =
    media(
      usados.map(
        x => x.preco_m2
      )
    );

  const referencia =
    ponderado * 0.60 +
    med * 0.40;

  const mercado =
    referencia * area;

  const rapida =
    mercado * 0.95;

  const maximo =
    mercado * 1.05;

  const simMedia =
    media(
      usados.map(
        x =>
          x.score_similaridade
      )
    );

  return {
    calculada: true,

    metodologia:
      'Preço por m² ponderado pela similaridade dos comparáveis, combinado com a mediana para reduzir distorções. Prioridade: bairro, tipo, área, quartos/suítes, conservação, vagas, condomínio, piscina/sauna, diferenciais e R$/m².',

    comparaveis_usados:
      usados.length,

    comparaveis_alta_similaridade:
      fortes.length,

    similaridade_media:
      Math.round(
        simMedia || 0
      ),

    area_avaliada_m2:
      area,

    preco_m2_referencia:
      Math.round(
        referencia
      ),

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

    valores_formatados: {
      venda_rapida:
        moeda(rapida),

      mercado:
        moeda(mercado),

      maximo_sugerido:
        moeda(maximo)
    }
  };
}

function cacheGet(key) {
  const x =
    searchCache.get(key);

  if (!x) {
    return null;
  }

  if (
    Date.now() - x.at >
    CACHE_TTL_MS
  ) {
    searchCache.delete(key);
    return null;
  }

  return x.data;
}

function cacheSet(
  key,
  data
) {
  if (
    searchCache.size >=
    CACHE_MAX
  ) {
    const first =
      searchCache
        .keys()
        .next()
        .value;

    if (first) {
      searchCache.delete(first);
    }
  }

  searchCache.set(
    key,
    {
      at: Date.now(),
      data
    }
  );
}

app.get(
  '/health',
  (req, res) =>
    res.json({
      ok: true,
      versao: 'PRECISAO-V11'
    })
);

app.get(
  '/',
  (req, res) =>
    res.json({
      status:
        'AYRO ACM API online',

      versao:
        'PRECISAO-V11',

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

  async (req, res) => {
    try {
      const q =
        String(
          req.query.q || ''
        ).trim();

      if (!q) {
        return res
          .status(400)
          .json({
            erro:
              'Informe uma pesquisa.'
          });
      }

      const apiKey =
        process.env.SERPAPI_KEY;

      if (!apiKey) {
        return res
          .status(500)
          .json({
            erro:
              'SERPAPI_KEY não configurada no servidor.'
          });
      }

      const busca =
        dadosDaBusca(
          q,
          req.query
        );

      const cacheKey =        JSON.stringify({
          q: norm(q),
          ...busca
        });

      const cached =
        cacheGet(cacheKey);

      if (cached) {
        return res.json({
          ...cached,
          cache: true
        });
      }

      const cidade =
        String(busca.cidade || '')
          .trim();

      const bairro =
        String(busca.bairro || '')
          .trim();

      const tipo =
        String(busca.tipo || '')
          .trim();

      const consultas = [];

      /*
        Mantemos a pesquisa ampla.
        Piscina, sauna, condomínio e conservação
        NÃO são usados para eliminar anúncios.
        Esses dados servem apenas para aumentar
        ou diminuir a similaridade.
      */

      if (
        tipo &&
        bairro &&
        cidade
      ) {
        consultas.push(
          `${tipo} à venda ${bairro} ${cidade}`
        );
      }

      if (
        tipo &&
        bairro &&
        cidade &&
        busca.quartos
      ) {
        consultas.push(
          `${tipo} ${busca.quartos} quartos à venda ${bairro} ${cidade}`
        );
      }

      if (
        tipo &&
        bairro &&
        cidade &&
        busca.area
      ) {
        consultas.push(
          `${tipo} à venda ${bairro} ${cidade} ${Math.round(busca.area)} m²`
        );
      }

      if (
        tipo &&
        cidade &&
        busca.quartos
      ) {
        consultas.push(
          `${tipo} ${busca.quartos} quartos à venda ${cidade}`
        );
      }

      if (
        tipo &&
        cidade
      ) {
        consultas.push(
          `${tipo} à venda ${cidade}`
        );
      }

      consultas.push(q);

      const consultasUnicas =
        [...new Set(
          consultas
            .map(x => x.trim())
            .filter(Boolean)
        )];

      const porLink =
        new Map();

      const errosBusca = [];

      for (
        const consulta
        of consultasUnicas
      ) {
        const retorno =
          await buscarSerp(
            apiKey,
            consulta,
            20
          );

        if (retorno.erro) {
          errosBusca.push({
            consulta,
            erro:
              retorno.erro
          });

          if (retorno.fatal) {
            break;
          }
        }

        for (
          const item
          of retorno.resultados
        ) {
          if (!item.link) {
            continue;
          }

          const link =
            normalizarLink(
              item.link
            );

          if (!link) {
            continue;
          }

          /*
            Evita duplicar o mesmo imóvel
            encontrado em consultas diferentes.
          */
          if (
            !porLink.has(link)
          ) {
            porLink.set(
              link,
              {
                ...item,
                link
              }
            );
          }
        }
      }

      const candidatos =
        [...porLink.values()];

      /*
        Primeiro tentamos enriquecer anúncios
        individuais para obter preço, área,
        quartos e demais características
        diretamente da página.
      */

      const individuais =
        candidatos.filter(
          x =>
            ehLinkIndividual(
              x.link
            )
        );

      const limiteEnriquecimento =
        individuais.slice(
          0,
          24
        );

      const enriquecidos = [];

      /*
        Processamento em pequenos grupos
        para não sobrecarregar os portais.
      */
      for (
        let i = 0;
        i <
        limiteEnriquecimento.length;
        i += 4
      ) {
        const grupo =
          limiteEnriquecimento.slice(
            i,
            i + 4
          );

        const respostas =
          await Promise.all(
            grupo.map(
              item =>
                enriquecerPagina(
                  item,
                  busca
                )
            )
          );

        enriquecidos.push(
          ...respostas
        );
      }

      /*
        Mantemos também os candidatos que
        não puderam ser enriquecidos.

        Eles ainda podem possuir preço e área
        no título/snippet do Google.
      */

      const linksEnriquecidos =
        new Set(
          enriquecidos.map(
            x =>
              normalizarLink(
                x.link
              )
          )
        );

      const restantes =
        candidatos.filter(
          x =>
            !linksEnriquecidos.has(
              normalizarLink(
                x.link
              )
            )
        );

      const processados = [
        ...enriquecidos.map(
          x =>
            avaliarItem(
              x,
              busca
            )
        ),

        ...restantes.map(
          x =>
            avaliarItem(
              x,
              busca
            )
        )
      ];

      /*
        Um anúncio só entra na ACM quando
        possui dados reais suficientes.

        Não inventamos preço ou área.
      */

      const comparaveis =
        processados
          .filter(
            x =>
              x.comparavel_valido &&
              Number.isFinite(
                x.preco_valor
              ) &&
              Number.isFinite(
                x.area_valor
              ) &&
              Number.isFinite(
                x.preco_m2
              )
          )
          .sort(
            (a, b) =>
              b.score_similaridade -
              a.score_similaridade
          )
          .slice(
            0,
            MAX_COMPARAVEIS
          );

      /*
        Os demais resultados ficam como
        referências, mas não entram no cálculo.
      */

      const referencias =
        processados
          .filter(
            x =>
              !comparaveis.some(
                c =>
                  normalizarLink(
                    c.link
                  ) ===
                  normalizarLink(
                    x.link
                  )
              )
          )
          .sort(
            (a, b) =>
              b.score_similaridade -
              a.score_similaridade
          )
          .slice(
            0,
            30
          );

      const avaliacao =
        calcularAvaliacao(
          comparaveis,
          busca.area
        );

      const payload = {
        sucesso: true,

        versao:
          'PRECISAO-V12-MP',

        consulta:
          q,

        criterios:
          busca,

        total:
          processados.length,

        total_comparaveis:
          comparaveis.length,

        minimo_comparaveis:
          MIN_COMPARAVEIS,

        comparaveis,

        referencias,

        avaliacao,

        erros_busca:
          errosBusca,

        resultados: [
          ...comparaveis,
          ...referencias
        ]
      };

      cacheSet(
        cacheKey,
        payload
      );

      return res.json(
        payload
      );

    } catch (e) {
      console.error(
        'ERRO AYRO:',
        e
      );

      return res
        .status(500)
        .json({
          sucesso: false,

          erro:
            'Erro interno na pesquisa.',

          detalhe:
            e.message ||
            String(e),

          versao:
            'PRECISAO-V12-MP'
        });
    }
  }
);

/* ==========================================
   AYRO ACM PRO
   MERCADO PAGO + SUPABASE
========================================== */

const mpAccessToken =
  () =>
    process.env.MP_ACCESS_TOKEN ||
    '';

const supabaseUrl =
  () =>
    String(
      process.env.SUPABASE_URL ||
      ''
    ).replace(/\/$/, '');

const supabaseSecret =
  () =>
    process.env.SUPABASE_SECRET_KEY ||
    '';

console.log(
  'AYRO CONFIG CHECK:',
  {
    SUPABASE_URL:
      !!process.env.SUPABASE_URL,

    SUPABASE_SECRET_KEY:
      !!process.env.SUPABASE_SECRET_KEY,

    MP_ACCESS_TOKEN:
      !!process.env.MP_ACCESS_TOKEN,

    MP_WEBHOOK_SECRET:
      !!process.env.MP_WEBHOOK_SECRET,

    SERPAPI_KEY:
      !!process.env.SERPAPI_KEY,

    RESEND_API_KEY:
      !!process.env.RESEND_API_KEY
  }
);

async function mpRequest(
  path,
  options = {}
) {
  const token =
    mpAccessToken();

  if (!token) {
    throw new Error(
      'MP_ACCESS_TOKEN não configurado.'
    );
  }

  const resposta =
    await fetch(
      `https://api.mercadopago.com${path}`,
      {
        ...options,

        headers: {
          Authorization:
            `Bearer ${token}`,

          'Content-Type':
            'application/json',

          ...(options.headers || {})
        }
      }
    );

  const texto =
    await resposta.text();

  let dados = {};

  try {
    dados =
      texto
        ? JSON.parse(texto)
        : {};
  } catch {
    dados = {
      raw: texto
    };
  }

  if (!resposta.ok) {
    const erro =
      dados?.message ||
      dados?.error ||
      `Mercado Pago HTTP ${resposta.status}`;

    throw new Error(
      erro
    );
  }

  return dados;
}

async function supabaseRequest(
  path,
  options = {}
) {
  const url =
    supabaseUrl();

  const secret =
    supabaseSecret();

  if (
    !url ||
    !secret
  ) {
    throw new Error(
      'Supabase não configurado.'
    );
  }

  const resposta =
    await fetch(
      `${url}${path}`,
      {
        ...options,

        headers: {
          apikey:
            secret,

          Authorization:
            `Bearer ${secret}`,

          'Content-Type':
            'application/json',

          Prefer:
            'return=representation',

          ...(options.headers || {})
        }
      }
    );

  const texto =
    await resposta.text();

  let dados = null;

  try {
    dados =
      texto
        ? JSON.parse(texto)
        : null;
  } catch {
    dados = texto;
  }

  if (!resposta.ok) {
    throw new Error(
      typeof dados === 'string'
        ? dados
        : (
            dados?.message ||
            dados?.error ||
            `Supabase HTTP ${resposta.status}`
          )
    );
  }

  return dados;
}async function supabaseAuthRequest(
  path,
  options = {}
) {
  const url =
    supabaseUrl();

  const secret =
    supabaseSecret();

  if (
    !url ||
    !secret
  ) {
    throw new Error(
      'Supabase não configurado.'
    );
  }

  const resposta =
    await fetch(
      `${url}${path}`,
      {
        ...options,

        headers: {
          apikey:
            secret,

          Authorization:
            `Bearer ${secret}`,

          'Content-Type':
            'application/json',

          ...(options.headers || {})
        }
      }
    );

  const texto =
    await resposta.text();

  let dados = null;

  try {
    dados =
      texto
        ? JSON.parse(texto)
        : null;
  } catch {
    dados = texto;
  }

  if (!resposta.ok) {
    const erro =
      new Error(
        `Supabase Auth HTTP ${resposta.status}`
      );

    erro.status =
      resposta.status;

    erro.dados =
      dados;

    throw erro;
  }

  return dados;
}

async function buscarUsuarioAuthPorEmail(
  email
) {
  const alvo =
    String(email || '')
      .trim()
      .toLowerCase();

  if (!alvo) {
    return null;
  }

  const dados =
    await supabaseAuthRequest(
      '/auth/v1/admin/users?page=1&per_page=1000',
      {
        method: 'GET'
      }
    );

  const users =
    Array.isArray(dados)
      ? dados
      : (
          Array.isArray(dados?.users)
            ? dados.users
            : []
        );

  return (
    users.find(
      u =>
        String(u?.email || '')
          .trim()
          .toLowerCase() === alvo
    ) || null
  );
}

async function criarOuAtualizarUsuarioAuth(
  email,
  password
) {
  let user =
    await buscarUsuarioAuthPorEmail(
      email
    );

  if (user?.id) {
    const atualizado =
      await supabaseAuthRequest(
        `/auth/v1/admin/users/${encodeURIComponent(user.id)}`,
        {
          method: 'PUT',

          body:
            JSON.stringify({
              password,
              email_confirm: true
            })
        }
      );

    return (
      atualizado?.user ||
      atualizado ||
      user
    );
  }

  const criado =
    await supabaseAuthRequest(
      '/auth/v1/admin/users',
      {
        method: 'POST',

        body:
          JSON.stringify({
            email,
            password,
            email_confirm: true,

            user_metadata: {
              app:
                'AYRO ACM Pro'
            }
          })
      }
    );

  return (
    criado?.user ||
    criado
  );
}

async function garantirUsuarioAuthParaEmail(email) {
  const existente =
    await buscarUsuarioAuthPorEmail(email);

  if (existente?.id) {
    return existente;
  }

  const senhaTemporaria =
    crypto.randomBytes(32).toString('hex') +
    'Aa1!';

  const criado =
    await supabaseAuthRequest(
      '/auth/v1/admin/users',
      {
        method: 'POST',

        body: JSON.stringify({
          email,
          password:
            senhaTemporaria,
          email_confirm: true,

          user_metadata: {
            app:
              'AYRO ACM Pro'
          }
        })
      }
    );

  return criado?.user || criado;
}

function ayroAppUrl() {
  return String(
    process.env.APP_URL ||
    'https://ayro-acm.onrender.com'
  ).replace(/\/$/, '');
}

async function enviarEmailCriarSenha(email) {
  const redirectTo =
    ayroAppUrl();

  await supabaseAuthRequest(
    `/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
    {
      method: 'POST',
      body:
        JSON.stringify({
          email
        })
    }
  );

  console.log(
    'E-mail de criação de senha solicitado:',
    email
  );
}

async function garantirProfileAtivo(
  userId,
  email,
  acessoFim
) {
  if (!userId) {
    return null;
  }

  const rows =
    await supabaseRequest(
      '/rest/v1/profiles?on_conflict=id',
      {
        method: 'POST',

        headers: {
          Prefer:
            'resolution=merge-duplicates,return=representation'
        },

        body:
          JSON.stringify({
            id:
              userId,

            email,

            subscription_status:
              'active',

            subscription_end:
              acessoFim
          })
      }
    );

  return (
    Array.isArray(rows) &&
    rows.length
      ? rows[0]
      : null
  );
}

async function buscarAssinaturaPorReferencia(
  externalReference
) {
  if (!externalReference) {
    return null;
  }

  const rows =
    await supabaseRequest(
      `/rest/v1/ayro_assinaturas?external_reference=eq.${encodeURIComponent(externalReference)}&select=*`,
      {
        method: 'GET'
      }
    );

  return (
    Array.isArray(rows) &&
    rows.length
      ? rows[0]
      : null
  );
}

async function buscarAssinaturaPorSubscriptionId(
  subscriptionId
) {
  if (!subscriptionId) {
    return null;
  }

  const rows =
    await supabaseRequest(
      `/rest/v1/ayro_assinaturas?mercado_pago_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=*`,
      {
        method: 'GET'
      }
    );

  return (
    Array.isArray(rows) &&
    rows.length
      ? rows[0]
      : null
  );
}

async function buscarAssinaturaPorEmail(
  email
) {
  if (!email) {
    return null;
  }

  const rows =
    await supabaseRequest(
      `/rest/v1/ayro_assinaturas?email=eq.${encodeURIComponent(email)}&select=*&order=created_at.desc&limit=1`,
      {
        method: 'GET'
      }
    );

  return (
    Array.isArray(rows) &&
    rows.length
      ? rows[0]
      : null
  );
}

async function atualizarAssinatura(
  id,
  patch
) {
  if (!id) {
    return null;
  }

  const rows =
    await supabaseRequest(
      `/rest/v1/ayro_assinaturas?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',

        body:
          JSON.stringify({
            ...patch,

            updated_at:
              new Date().toISOString()
          })
      }
    );

  return (
    Array.isArray(rows) &&
    rows.length
      ? rows[0]
      : null
  );
}

async function atualizarProfile(
  userId,
  status,
  acessoFim
) {
  if (!userId) {
    return null;
  }

  const patch = {
    subscription_status:
      status
  };

  if (
    acessoFim !== undefined
  ) {
    patch.subscription_end =
      acessoFim;
  }

  const rows =
    await supabaseRequest(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',

        body:
          JSON.stringify(
            patch
          )
      }
    );

  return (
    Array.isArray(rows) &&
    rows.length
      ? rows[0]
      : null
  );
}

function adicionarDias(
  dataBase,
  dias
) {
  const d =
    new Date(
      dataBase ||
      Date.now()
    );

  d.setUTCDate(
    d.getUTCDate() +
    dias
  );

  return d.toISOString();
}

/* ==========================================
   CRIAR ASSINATURA CARTÃO
========================================== */

app.post(
  '/api/mercadopago/criar-assinatura',
  async (req, res) => {
    try {
      const {
        email,
        user_id
      } = req.body || {};

      if (!email) {
        return res
          .status(400)
          .json({
            erro:
              'Informe o e-mail do cliente.'
          });
      }

      const externalReference =
        `AYRO-${crypto.randomUUID()}`;

      const agora =
        new Date().toISOString();

      const criadas =
        await supabaseRequest(
          '/rest/v1/ayro_assinaturas',
          {
            method:
              'POST',

            body:
              JSON.stringify({
                user_id:
                  user_id || null,

                email,

                plano:
                  'AYRO ACM Pro',

                status:
                  'pending',

                metodo_pagamento:
                  'cartao_assinatura',

                external_reference:
                  externalReference,

                valor:
                  49.90,

                acesso_inicio:
                  null,

                acesso_fim:
                  null,

                proximo_pagamento:
                  null,

                created_at:
                  agora,

                updated_at:
                  agora
              })
          }
        );

      const assinatura =
        await mpRequest(
          '/preapproval',
          {
            method:
              'POST',

            body:
              JSON.stringify({
                reason:
                  'AYRO ACM Pro',

                external_reference:
                  externalReference,

                payer_email:
                  email,

                auto_recurring: {
                  frequency:
                    1,

                  frequency_type:
                    'months',

                  transaction_amount:
                    49.90,

                  currency_id:
                    'BRL'
                },

                back_url:
                  'https://ayro-acm-api-prod.onrender.com',

                status:
                  'pending'
              })
          }
        );

      const registro =
        Array.isArray(criadas) &&
        criadas.length
          ? criadas[0]
          : null;

      if (registro?.id) {
        await atualizarAssinatura(
          registro.id,
          {
            mercado_pago_subscription_id:
              String(
                assinatura.id || ''
              ),

            status:
              assinatura.status ||
              'pending',

            proximo_pagamento:
              assinatura.next_payment_date ||
              null
          }
        );
      }

      return res.json({
        sucesso:
          true,

        assinatura_id:
          assinatura.id,

        status:
          assinatura.status,

        checkout_url:
          assinatura.init_point,

        external_reference:
          externalReference
      });

    } catch (erro) {
      console.error(
        'Erro ao criar assinatura:',
        erro.dados || erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Erro interno ao criar assinatura.',

          detalhe:
            erro.dados ||
            erro.message ||
            String(erro)
        });
    }
  }
);

/* ==========================================
   CRIAR PAGAMENTO PIX
========================================== */

app.post(
  '/api/mercadopago/criar-pix',
  async (req, res) => {
    try {
      const {
        email,
        user_id,
        nome
      } = req.body || {};

      if (!email) {
        return res
          .status(400)
          .json({
            erro:
              'Informe o e-mail do cliente.'
          });
      }

      const externalReference =
        `AYRO-PIX-${crypto.randomUUID()}`;

      const agora =
        new Date().toISOString();

      const criadas =
        await supabaseRequest(
          '/rest/v1/ayro_assinaturas',
          {
            method: 'POST',

            body: JSON.stringify({
              user_id:
                user_id || null,

              email,

              plano:
                'AYRO ACM Pro',

              status:
                'pending',

              metodo_pagamento:
                'pix',

              external_reference:
                externalReference,

              valor:
                49.90,

              acesso_inicio:
                null,

              acesso_fim:
                null,

              proximo_pagamento:
                null,

              created_at:
                agora,

              updated_at:
                agora
            })
          }
        );

      const idempotencyKey =
        crypto.randomUUID();

      const pagamento =
        await mpRequest(
          '/v1/payments',
          {
            method: 'POST',

            headers: {
              'X-Idempotency-Key':
                idempotencyKey
            },

            body: JSON.stringify({
              transaction_amount:
                49.90,

              description:
                'AYRO ACM Pro - 30 dias',

              payment_method_id:
                'pix',

              external_reference:
                externalReference,

              payer: {
                email,

                first_name:
                  String(
                    nome ||
                    'Cliente AYRO'
                  )
                    .trim()
                    .split(/\s+/)[0]
              },

              metadata: {
                produto:
                  'AYRO ACM Pro',

                tipo:
                  'pix_30_dias',

                user_id:
                  user_id || ''
              }
            })
          }
        );      const registro =
        Array.isArray(criadas) &&
        criadas.length
          ? criadas[0]
          : null;

      if (registro?.id) {
        await atualizarAssinatura(
          registro.id,
          {
            mercado_pago_payment_id:
              String(
                pagamento.id || ''
              ),

            status:
              pagamento.status ||
              'pending'
          }
        );
      }

      const transactionData =
        pagamento
          ?.point_of_interaction
          ?.transaction_data || {};

      return res.json({
        sucesso:
          true,

        payment_id:
          pagamento.id,

        status:
          pagamento.status,

        external_reference:
          externalReference,

        qr_code:
          transactionData.qr_code ||
          '',

        qr_code_base64:
          transactionData.qr_code_base64 ||
          '',

        ticket_url:
          transactionData.ticket_url ||
          ''
      });

    } catch (erro) {
      console.error(
        'Erro ao criar Pix:',
        erro.dados || erro
      );

      return res
        .status(500)
        .json({
          sucesso:
            false,

          erro:
            'Erro interno ao gerar Pix.',

          detalhe:
            erro.dados ||
            erro.message ||
            String(erro)
        });
    }
  }
);

/* ==========================================
   CONSULTAR PAGAMENTO PIX
========================================== */

app.get(
  '/api/mercadopago/pagamento/:id',
  async (req, res) => {
    try {
      const paymentId =
        String(
          req.params.id || ''
        ).trim();

      if (!paymentId) {
        return res
          .status(400)
          .json({
            erro:
              'Pagamento não informado.'
          });
      }

      const pagamento =
        await mpRequest(
          `/v1/payments/${encodeURIComponent(paymentId)}`,
          {
            method:
              'GET'
          }
        );

      if (
        String(
          pagamento.status || ''
        ).toLowerCase() ===
        'approved'
      ) {
        try {
          await processarPagamentoAprovado(
            pagamento
          );
        } catch (erroProcessamento) {
          console.error(
            'Pagamento aprovado, mas houve erro na ativação:',
            erroProcessamento
          );
        }
      }

      return res.json({
        sucesso:
          true,

        id:
          pagamento.id,

        status:
          pagamento.status,

        status_detail:
          pagamento.status_detail,

        external_reference:
          pagamento.external_reference,

        date_approved:
          pagamento.date_approved ||
          null
      });

    } catch (erro) {
      console.error(
        'Erro ao consultar pagamento:',
        erro
      );

      return res
        .status(500)
        .json({
          sucesso:
            false,

          erro:
            'Erro ao consultar pagamento.',

          detalhe:
            erro.message ||
            String(erro)
        });
    }
  }
);

/* ==========================================
   ATIVAR CONTA APÓS PIX
========================================== */

app.post(
  '/api/mercadopago/ativar-conta-pix',
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email || ''
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body?.password || ''
        );

      const paymentId =
        String(
          req.body?.payment_id || ''
        ).trim();

      if (!email) {
        return res
          .status(400)
          .json({
            sucesso:
              false,

            erro:
              'Informe o e-mail.'
          });
      }

      if (
        !password ||
        password.length < 6
      ) {
        return res
          .status(400)
          .json({
            sucesso:
              false,

            erro:
              'A senha precisa ter pelo menos 6 caracteres.'
          });
      }

      if (!paymentId) {
        return res
          .status(400)
          .json({
            sucesso:
              false,

            erro:
              'Pagamento não identificado.'
          });
      }

      const pagamento =
        await mpRequest(
          `/v1/payments/${encodeURIComponent(paymentId)}`,
          {
            method:
              'GET'
          }
        );

      if (
        String(
          pagamento.status || ''
        ).toLowerCase() !==
        'approved'
      ) {
        return res
          .status(403)
          .json({
            sucesso:
              false,

            erro:
              'O pagamento ainda não foi aprovado.'
          });
      }

      const emailPagamento =
        String(
          pagamento
            ?.payer
            ?.email ||
          ''
        )
          .trim()
          .toLowerCase();

      if (
        emailPagamento &&
        emailPagamento !== email
      ) {
        return res
          .status(403)
          .json({
            sucesso:
              false,

            erro:
              'O e-mail informado não corresponde ao pagamento.'
          });
      }

      await processarPagamentoAprovado(
        pagamento
      );

      const usuario =
        await criarOuAtualizarUsuarioAuth(
          email,
          password
        );

      const userId =
        usuario?.id;

      if (!userId) {
        throw new Error(
          'Não foi possível criar o usuário no Supabase.'
        );
      }

      const externalReference =
        String(
          pagamento.external_reference ||
          ''
        );

      let registro =
        await buscarAssinaturaPorReferencia(
          externalReference
        );

      if (!registro) {
        registro =
          await buscarAssinaturaPorEmail(
            email
          );
      }

      let acessoFim =
        registro?.acesso_fim ||
        null;

      if (!acessoFim) {
        acessoFim =
          adicionarDias(
            new Date(),
            30
          );
      }

      if (registro?.id) {
        await atualizarAssinatura(
          registro.id,
          {
            user_id:
              userId,

            email,

            status:
              'active',

            acesso_fim:
              acessoFim,

            mercado_pago_payment_id:
              String(
                pagamento.id ||
                paymentId
              )
          }
        );
      }

      await garantirProfileAtivo(
        userId,
        email,
        acessoFim
      );

      return res.json({
        sucesso:
          true,

        user_id:
          userId,

        email,

        status:
          'active',

        acesso_fim:
          acessoFim,

        mensagem:
          'Conta ativada com sucesso.'
      });

    } catch (erro) {
      console.error(
        'Erro ao ativar conta Pix:',
        erro.dados ||
        erro
      );

      return res
        .status(500)
        .json({
          sucesso:
            false,

          erro:
            'Não foi possível ativar a conta.',

          detalhe:
            erro?.dados?.msg ||
            erro?.dados?.message ||
            erro.message ||
            String(erro)
        });
    }
  }
);

/* ==========================================
   PROCESSAR PAGAMENTO PIX APROVADO
========================================== */

async function processarPagamentoAprovado(
  pagamento
) {
  if (!pagamento?.id) {
    return null;
  }

  const externalReference =
    String(
      pagamento.external_reference ||
      ''
    );

  const email =
    String(
      pagamento?.payer?.email ||
      ''
    )
      .trim()
      .toLowerCase();

  let registro =
    await buscarAssinaturaPorReferencia(
      externalReference
    );

  if (
    !registro &&
    email
  ) {
    registro =
      await buscarAssinaturaPorEmail(
        email
      );
  }

  if (!registro) {
    console.warn(
      'Pagamento aprovado sem assinatura correspondente:',
      pagamento.id
    );

    return null;
  }

  const mesmoPagamento =
    String(
      registro.mercado_pago_payment_id ||
      ''
    ) ===
    String(
      pagamento.id
    );

  const jaAtivo =
    String(
      registro.status ||
      ''
    ).toLowerCase() ===
    'active';

  if (
    mesmoPagamento &&
    jaAtivo &&
    registro.user_id
  ) {
    console.log(
      'Pix já processado anteriormente:',
      pagamento.id
    );

    return registro;
  }

  const agora =
    new Date();

  let acessoInicio =
    registro.acesso_inicio
      ? new Date(
          registro.acesso_inicio
        )
      : agora;

  if (
    Number.isNaN(
      acessoInicio.getTime()
    )
  ) {
    acessoInicio =
      agora;
  }

  let baseFim =
    agora;

  if (
    registro.acesso_fim
  ) {
    const fimAtual =
      new Date(
        registro.acesso_fim
      );

    if (
      !Number.isNaN(
        fimAtual.getTime()
      ) &&
      fimAtual > agora
    ) {
      baseFim =
        fimAtual;
    }
  }

  const acessoFim =
    adicionarDias(
      baseFim,
      30
    );

  let usuario =
    null;

  if (email) {
    usuario =
      await garantirUsuarioAuthParaEmail(
        email
      );
  }

  const userId =
    usuario?.id ||
    registro.user_id ||
    null;

  const atualizado =
    await atualizarAssinatura(
      registro.id,
      {
        user_id:
          userId,

        email:
          email ||
          registro.email,

        status:
          'active',

        metodo_pagamento:
          'pix',

        mercado_pago_payment_id:
          String(
            pagamento.id
          ),

        acesso_inicio:
          acessoInicio.toISOString(),

        acesso_fim:
          acessoFim,

        proximo_pagamento:
          null
      }
    );

  if (userId) {
    await garantirProfileAtivo(
      userId,
      email ||
      registro.email,
      acessoFim
    );
  }

  /*
    Envia o e-mail somente quando este
    pagamento ainda não havia sido
    processado anteriormente.
  */
  if (
    email &&
    !mesmoPagamento
  ) {
    try {
      await enviarEmailCriarSenha(
        email
      );

      console.log(
        'E-mail para criação de senha enviado:',
        email
      );
    } catch (erroEmail) {
      console.error(
        'Erro ao enviar e-mail de criação de senha:',
        erroEmail
      );
    }
  }

  return (
    atualizado ||
    registro
  );
}

/* ==========================================
   PROCESSAR ASSINATURA
========================================== */

async function processarAssinatura(
  assinatura
) {
  if (!assinatura?.id) {
    return null;
  }

  const subscriptionId =
    String(
      assinatura.id
    );

  const externalReference =
    String(
      assinatura.external_reference ||
      ''
    );

  const email =
    String(
      assinatura?.payer_email ||
      ''
    )
      .trim()
      .toLowerCase();

  let registro =
    await buscarAssinaturaPorSubscriptionId(
      subscriptionId
    );

  if (
    !registro &&
    externalReference
  ) {
    registro =
      await buscarAssinaturaPorReferencia(
        externalReference
      );
  }

  if (
    !registro &&
    email
  ) {
    registro =
      await buscarAssinaturaPorEmail(
        email
      );
  }

  if (!registro) {
    console.warn(
      'Assinatura Mercado Pago sem registro correspondente:',
      subscriptionId
    );

    return null;
  }

  const status =
    String(
      assinatura.status ||
      ''
    ).toLowerCase();

  const ativo =
    [
      'authorized',
      'active'
    ].includes(status);

  let acessoFim =
    registro.acesso_fim ||
    null;

  if (ativo) {
    const proximo =
      assinatura.next_payment_date
        ? new Date(
            assinatura.next_payment_date
          )
        : null;

    if (
      proximo &&
      !Number.isNaN(
        proximo.getTime()
      )
    ) {
      acessoFim =
        proximo.toISOString();
    } else {
      acessoFim =
        adicionarDias(
          new Date(),
          30
        );
    }
  }

  let userId =
    registro.user_id ||
    null;

  if (
    ativo &&
    email &&
    !userId
  ) {
    const usuario =
      await garantirUsuarioAuthParaEmail(
        email
      );

    userId =
      usuario?.id ||
      null;
  }

  const atualizado =
    await atualizarAssinatura(
      registro.id,
      {
        user_id:
          userId,

        email:
          email ||
          registro.email,

        mercado_pago_subscription_id:
          subscriptionId,

        status:
          ativo
            ? 'active'
            : status,

        metodo_pagamento:
          'cartao_assinatura',

        acesso_inicio:
          ativo &&
          !registro.acesso_inicio
            ? new Date().toISOString()
            : registro.acesso_inicio,

        acesso_fim:
          acessoFim,

        proximo_pagamento:
          assinatura.next_payment_date ||
          null
      }
    );

  if (userId) {
    await atualizarProfile(
      userId,
      ativo
        ? 'active'
        : status,
      acessoFim
    );
  }

  return (
    atualizado ||
    registro
  );
}/* ==========================================
   WEBHOOK MERCADO PAGO
========================================== */

app.post(
  '/api/mercadopago/webhook',
  async (req, res) => {
    /*
      Respondemos rapidamente ao Mercado Pago.
      O processamento continua logo abaixo.
    */
    res.status(200).json({
      recebido: true
    });

    try {
      const body =
        req.body || {};

      const type =
        String(
          body.type ||
          body.topic ||
          ''
        ).toLowerCase();

      const dataId =
        String(
          body?.data?.id ||
          body.id ||
          ''
        ).trim();

      console.log(
        'Webhook Mercado Pago:',
        {
          type,
          dataId
        }
      );

      /*
        PAGAMENTO / PIX
      */
      if (
        dataId &&
        (
          type === 'payment' ||
          type === 'payments'
        )
      ) {
        const pagamento =
          await mpRequest(
            `/v1/payments/${encodeURIComponent(dataId)}`,
            {
              method: 'GET'
            }
          );

        const status =
          String(
            pagamento.status ||
            ''
          ).toLowerCase();

        if (
          status ===
          'approved'
        ) {
          await processarPagamentoAprovado(
            pagamento
          );
        } else {
          const externalReference =
            String(
              pagamento.external_reference ||
              ''
            );

          const registro =
            await buscarAssinaturaPorReferencia(
              externalReference
            );

          if (registro?.id) {
            await atualizarAssinatura(
              registro.id,
              {
                mercado_pago_payment_id:
                  String(
                    pagamento.id ||
                    ''
                  ),

                status:
                  status ||
                  'pending'
              }
            );
          }
        }

        return;
      }

      /*
        ASSINATURA RECORRENTE
      */
      if (
        dataId &&
        (
          type === 'subscription_preapproval' ||
          type === 'preapproval' ||
          type === 'subscription'
        )
      ) {
        const assinatura =
          await mpRequest(
            `/preapproval/${encodeURIComponent(dataId)}`,
            {
              method:
                'GET'
            }
          );

        await processarAssinatura(
          assinatura
        );

        return;
      }

      /*
        Algumas notificações do Mercado Pago
        podem chegar sem "type" explícito.
        Se o ID estiver presente, tentamos
        identificar como pagamento.
      */
      if (dataId) {
        try {
          const pagamento =
            await mpRequest(
              `/v1/payments/${encodeURIComponent(dataId)}`,
              {
                method:
                  'GET'
              }
            );

          if (pagamento?.id) {
            const status =
              String(
                pagamento.status ||
                ''
              ).toLowerCase();

            if (
              status ===
              'approved'
            ) {
              await processarPagamentoAprovado(
                pagamento
              );
            }

            return;
          }
        } catch {
          /*
            Não era pagamento.
            Tentamos assinatura abaixo.
          */
        }

        try {
          const assinatura =
            await mpRequest(
              `/preapproval/${encodeURIComponent(dataId)}`,
              {
                method:
                  'GET'
              }
            );

          if (assinatura?.id) {
            await processarAssinatura(
              assinatura
            );
          }
        } catch (erroAssinatura) {
          console.log(
            'Webhook ignorado:',
            erroAssinatura.message ||
            String(
              erroAssinatura
            )
          );
        }
      }

    } catch (erro) {
      console.error(
        'Erro no webhook Mercado Pago:',
        erro.dados ||
        erro
      );
    }
  }
);

/* ==========================================
   WEBHOOK ALTERNATIVO
   Mantido para compatibilidade
========================================== */

app.post(
  '/webhook',
  async (req, res) => {
    res.status(200).json({
      recebido: true
    });

    try {
      const body =
        req.body || {};

      const type =
        String(
          body.type ||
          body.topic ||
          ''
        ).toLowerCase();

      const dataId =
        String(
          body?.data?.id ||
          body.id ||
          ''
        ).trim();

      if (!dataId) {
        return;
      }

      if (
        type === 'payment' ||
        type === 'payments' ||
        !type
      ) {
        try {
          const pagamento =
            await mpRequest(
              `/v1/payments/${encodeURIComponent(dataId)}`,
              {
                method:
                  'GET'
              }
            );

          if (
            String(
              pagamento.status ||
              ''
            ).toLowerCase() ===
            'approved'
          ) {
            await processarPagamentoAprovado(
              pagamento
            );
          }

          return;

        } catch (erroPagamento) {
          console.log(
            'ID do webhook não identificado como pagamento:',
            dataId
          );
        }
      }

      try {
        const assinatura =
          await mpRequest(
            `/preapproval/${encodeURIComponent(dataId)}`,
            {
              method:
                'GET'
            }
          );

        if (assinatura?.id) {
          await processarAssinatura(
            assinatura
          );
        }

      } catch (erroAssinatura) {
        console.log(
          'Webhook alternativo ignorado:',
          erroAssinatura.message ||
          String(
            erroAssinatura
          )
        );
      }

    } catch (erro) {
      console.error(
        'Erro no webhook alternativo:',
        erro
      );
    }
  }
);

/* ==========================================
   VERIFICAR ACESSO DO CLIENTE
========================================== */

app.get(
  '/api/acesso',
  async (req, res) => {
    try {
      const email =
        String(
          req.query.email ||
          ''
        )
          .trim()
          .toLowerCase();

      if (!email) {
        return res
          .status(400)
          .json({
            ativo:
              false,

            erro:
              'Informe o e-mail.'
          });
      }

      const registro =
        await buscarAssinaturaPorEmail(
          email
        );

      if (!registro) {
        return res.json({
          ativo:
            false,

          status:
            'not_found',

          plano:
            'AYRO ACM Pro',

          acesso_inicio:
            null,

          acesso_fim:
            null
        });
      }

      const agora =
        new Date();

      const fim =
        registro.acesso_fim
          ? new Date(
              registro.acesso_fim
            )
          : null;

      const status =
        String(
          registro.status ||
          ''
        ).toLowerCase();

      let ativo =
        false;

      if (
        registro.metodo_pagamento ===
        'pix'
      ) {
        ativo =
          status === 'active' &&
          fim &&
          fim > agora;

      } else {
        ativo =
          [
            'active',
            'authorized',
            'approved'
          ].includes(status) &&
          (
            !fim ||
            fim > agora
          );
      }

      /*
        Se os 30 dias do Pix acabaram,
        marcamos a assinatura como expirada.
      */
      if (
        registro.metodo_pagamento ===
          'pix' &&
        status ===
          'active' &&
        fim &&
        fim <= agora
      ) {
        await atualizarAssinatura(
          registro.id,
          {
            status:
              'expired'
          }
        );

        if (
          registro.user_id
        ) {
          await atualizarProfile(
            registro.user_id,
            'inactive',
            registro.acesso_fim
          );
        }
      }

      return res.json({
        ativo,

        status:
          ativo
            ? 'active'
            : (
                fim &&
                fim <= agora
                  ? 'expired'
                  : status
              ),

        plano:
          registro.plano ||
          'AYRO ACM Pro',

        metodo_pagamento:
          registro.metodo_pagamento ||
          null,

        acesso_inicio:
          registro.acesso_inicio ||
          null,

        acesso_fim:
          registro.acesso_fim ||
          null
      });

    } catch (erro) {
      console.error(
        'Erro ao verificar acesso:',
        erro
      );

      return res
        .status(500)
        .json({
          ativo:
            false,

          erro:
            'Não foi possível verificar o acesso.'
        });
    }
  }
);

/* ==========================================
   ROTA DE STATUS DA API
========================================== */

app.get(
  '/api/status',
  (req, res) => {
    res.json({
      ok:
        true,

      sistema:
        'AYRO ACM Pro',

      api:
        'online',

      versao:
        'PRECISAO-V12-MP',

      comparaveis: {
        minimo:
          MIN_COMPARAVEIS,

        maximo:
          MAX_COMPARAVEIS
      },

      configuracao: {
        serpapi:
          !!process.env.SERPAPI_KEY,

        supabase:
          !!(
            process.env.SUPABASE_URL &&
            process.env.SUPABASE_SECRET_KEY
          ),

        mercado_pago:
          !!process.env.MP_ACCESS_TOKEN,

        email:
          !!process.env.RESEND_API_KEY
      }
    });
  }
);

/* ==========================================
   TRATAMENTO DE ROTA NÃO ENCONTRADA
========================================== */

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        sucesso:
          false,

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
   TRATAMENTO DE ERRO EXPRESS
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
      return next(
        erro
      );
    }

    return res
      .status(500)
      .json({
        sucesso:
          false,

        erro:
          'Erro interno do servidor.'
      });
  }
);

/* ==========================================
   INICIAR SERVIDOR
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
        `AYRO ACM API PRECISAO-V12-MP rodando na porta ${PORT}`
      );

      console.log(
        'Pesquisa de comparáveis:',
        process.env.SERPAPI_KEY
          ? 'configurada'
          : 'SERPAPI_KEY ausente'
      );

      console.log(
        'Mercado Pago:',
        process.env.MP_ACCESS_TOKEN
          ? 'configurado'
          : 'não configurado'
      );

      console.log(
        'Supabase:',
        (
          process.env.SUPABASE_URL &&
          process.env.SUPABASE_SECRET_KEY
        )
          ? 'configurado'
          : 'não configurado'
      );
    }
  );
}

/* ==========================================
   EXPORTS
========================================== */

module.exports = {
  app,
  dadosDaBusca,
  dadosDaUrl,
  ehLinkIndividual,
  extrairDaPagina,
  avaliarItem,
  calcularAvaliacao
};
