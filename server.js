const express = require('express');
const cors = require('cors');

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

function primeiroNumero(
  texto,
  re,
  min = 0,
  max = 999999
) {
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

function scoreProximidadeNumero(
  alvo,
  valor,
  peso,
  tol
) {
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
                ? (
                    v.value ||
                    v.amount ||
                    ''
                  )
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

  const attrs =
    extrairAtributos(clean);

  return {
    preco:
      allPrecos[0] || null,

    area:
      escolherArea(
        allAreas,
        busca.area
      ),

    quartos:
      allQuartos,

    ...attrs,

    texto:
      clean.slice(0, 20000)
  };
}

async function enriquecerPagina(item, busca) {
  if (!ehLinkIndividual(item.link)) {
    return item;
  }

  const ctrl = new AbortController();

  const timer =
    setTimeout(
      () => ctrl.abort(),
      FETCH_TIMEOUT_MS
    );

  try {
    const r =
      await fetch(
        item.link,
        {
          signal: ctrl.signal,
          redirect: 'follow',

          headers: {
            'user-agent': UA,
            'accept-language':
              'pt-BR,pt;q=0.9,en;q=0.7',
            accept:
              'text/html,application/xhtml+xml'
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

    const p =
      extrairDaPagina(
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

function avaliarItem(item, busca) {
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

  const nt =
    norm(full);

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
    norm(
      busca.conservacao
    ).includes(
      norm(conservacao)
    )
  ) {
    score += 8;
    detalhes.conservacao =
      true;
  } else {
    detalhes.conservacao =
      null;
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
    detalhes.vagas =
      true;
  } else {
    detalhes.vagas =
      null;
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
      norm(
        busca.diferenciais
      )
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
        ? `R$ ${Math.round(
            preco
          ).toLocaleString(
            'pt-BR'
          )}`
        : '',

    area:
      Number.isFinite(area)
        ? `${String(
            area
          ).replace(
            '.',
            ','
          )} m²`
        : '',

    preco_valor:
      preco,

    area_valor:
      area,

    preco_m2:
      precoM2,

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
          [401, 403, 429].includes(
            r.status
          )
      };
    }

    if (d.error) {
      return {
        resultados: [],
        erro:
          String(d.error),

        fatal:
          /invalid api key|unauthorized|credits|account|rate limit/i.test(
            String(d.error)
          )
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
  if (
    comps.length < 4
  ) {
    return comps;
  }

  const v =
    comps
      .map(
        x => x.preco_m2
      )
      .filter(
        Number.isFinite
      )
      .sort(
        (a, b) => a - b
      );

  if (
    v.length < 4
  ) {
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
      versao: 'PRECISAO-V12-MP'
    })
);

app.get(
  '/',
  (req, res) =>
    res.json({
      status:
        'AYRO ACM API online',

      versao:
        'PRECISAO-V12-MP',

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

      const cacheKey =
        norm(
          q +
          '|' +
          JSON.stringify(busca)
        );

      const cached =
        cacheGet(cacheKey);

      if (cached) {
        return res.json({
          ...cached,
          cache: true
        });
      }

      const vistos =
        new Set();

      const candidatos =
        [];

      const semArea =
        q
          .replace(
            /\b\d+(?:[.,]\d+)?\s*m(?:²|2)(?![a-z0-9])/i,
            ''
          )
          .replace(
            /\s{2,}/g,
            ' '
          )
          .trim();

      const principais = [
        `site:chavesnamao.com.br/imovel ${semArea} venda`,
        `site:imovelweb.com.br/propriedades ${semArea} venda`,
        `site:vivareal.com.br/imovel ${semArea} venda`,
        `site:zapimoveis.com.br/imovel ${semArea} venda`
      ];

      const fallback = [
        `${semArea} imóvel venda preço R$`,
        `${semArea} imóvel venda R$ m²`
      ];

      const erros_busca =
        [];

      const adicionar =
        (lista = []) => {
          for (
            const raw of lista
          ) {
            if (
              !raw?.link
            ) {
              continue;
            }

            const k =
              normalizarLink(
                raw.link
              );

            if (
              vistos.has(k)
            ) {
              continue;
            }

            vistos.add(k);

            candidatos.push(
              raw
            );
          }
        };

      const rodar =
        async consultas => {
          const lotes =
            await Promise.all(
              consultas.map(
                c =>
                  buscarSerp(
                    apiKey,
                    c,
                    20
                  )
              )
            );

          lotes.forEach(
            (t, i) => {
              if (t.erro) {
                erros_busca.push({
                  consulta:
                    consultas[i],

                  erro:
                    t.erro
                });
              }

              adicionar(
                t.resultados
              );
            }
          );

          const fatal =
            lotes.find(
              t => t.fatal
            );

          if (
            fatal &&
            candidatos.length === 0
          ) {
            throw new Error(
              `SERP_FATAL:${fatal.erro}`
            );
          }
        };

      await rodar(
        principais
      );

      if (
        candidatos.filter(
          x =>
            ehLinkIndividual(
              x.link
            )
        ).length < 8
      ) {
        await rodar(
          fallback
        );
      }

      const individuais =
        candidatos
          .filter(
            x =>
              ehLinkIndividual(
                x.link
              )
          )
          .slice(
            0,
            12
          );

      const enriquecidos =
        [];

      for (
        let i = 0;
        i <
        individuais.length;
        i += 6
      ) {
        const lote =
          individuais.slice(
            i,
            i + 6
          );

        enriquecidos.push(
          ...await Promise.all(
            lote.map(
              x =>
                enriquecerPagina(
                  x,
                  busca
                )
            )
          )
        );

        if (
          enriquecidos
            .map(
              x =>
                avaliarItem(
                  x,
                  busca
                )
            )
            .filter(
              x =>
                x.comparavel_valido
            ).length >= 6
        ) {
          break;
        }
      }

      const processados = [
        ...enriquecidos.map(
          x =>
            avaliarItem(
              x,
              busca
            )
        ),

        ...candidatos
          .filter(
            x =>
              !ehLinkIndividual(
                x.link
              )
          )
          .map(
            x =>
              avaliarItem(
                x,
                busca
              )
          )
      ];

      const comparaveis =
        processados
          .filter(
            x =>
              x.comparavel_valido
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

      const referencias =
        processados
          .filter(
            x =>
              !x.comparavel_valido
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

        erros_busca,

        resultados: [
          ...comparaveis,
          ...referencias
        ]
      };

      cacheSet(
        cacheKey,
        payload
      );

      res.json(
        payload
      );
    } catch (e) {
      console.error(
        'ERRO AYRO V12:',
        e
      );

      res
        .status(500)
        .json({
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
   MERCADO PAGO
   ASSINATURA AYRO ACM PRO
   R$ 49,90 / MÊS
========================================== */

const mpAccessToken = () =>
  process.env.MP_ACCESS_TOKEN || '';

async function mpGet(path) {
  const token =
    mpAccessToken();

  if (!token) {
    throw new Error(
      'MP_ACCESS_TOKEN não configurado no servidor.'
    );
  }

  const resposta =
    await fetch(
      `https://api.mercadopago.com${path}`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );

  const dados =
    await resposta
      .json()
      .catch(
        () => ({})
      );

  if (!resposta.ok) {
    const erro =
      new Error(
        `Mercado Pago HTTP ${resposta.status}`
      );

    erro.dados =
      dados;

    throw erro;
  }

  return dados;
}

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

      const {
        email
      } = req.body || {};

      if (!email) {
        return res
          .status(400)
          .json({
            erro:
              'Informe o e-mail do cliente.'
          });
      }

      const baseUrl =
        'https://ayro-acm.onrender.com';

      const assinatura = {
        reason:
          'AYRO ACM Pro',

        external_reference:
          `AYRO-${Date.now()}`,

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

      const resposta =
        await fetch(
          'https://api.mercadopago.com/preapproval',

          {
            method:
              'POST',

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

      const dados =
        await resposta.json();

      if (!resposta.ok) {
        console.error(
          'Erro Mercado Pago:',
          dados
        );

        return res
          .status(
            resposta.status
          )
          .json({
            erro:
              'Não foi possível criar a assinatura.',

            detalhes:
              dados
          });
      }

      return res.json({
        sucesso:
          true,

        assinatura_id:
          dados.id,

        status:
          dados.status,

        checkout_url:
          dados.init_point
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
      const id =
        String(
          req.params.id || ''
        ).trim();

      if (!id) {
        return res
          .status(400)
          .json({
            erro:
              'ID da assinatura não informado.'
          });
      }

      const dados =
        await mpGet(
          `/preapproval/${encodeURIComponent(id)}`
        );

      return res.json({
        sucesso:
          true,

        id:
          dados.id,

        status:
          dados.status,

        payer_email:
          dados.payer_email,

        external_reference:
          dados.external_reference,

        next_payment_date:
          dados.next_payment_date || null
      });
    } catch (erro) {
      console.error(
        'Erro ao consultar assinatura Mercado Pago:',
        erro.dados || erro
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
   WEBHOOK MERCADO PAGO
========================================== */

app.post(
  '/api/mercadopago/webhook',

  async (req, res) => {
    res.sendStatus(200);

    try {
      const body =
        req.body || {};

      const tipo =
        String(
          body.type ||
          body.topic ||
          ''
        ).trim();

      const dataId =
        String(
          body?.data?.id ||
          body.id ||
          ''
        ).trim();

      if (!dataId) {
        console.log(
          'Webhook Mercado Pago recebido sem data.id:',
          body
        );

        return;
      }

      if (
        tipo ===
          'subscription_preapproval' ||
        tipo ===
          'preapproval'
      ) {
        const assinatura =
          await mpGet(
            `/preapproval/${encodeURIComponent(dataId)}`
          );

        console.log(
          'MP assinatura atualizada:',
          {
            id:
              assinatura.id,

            status:
              assinatura.status,

            payer_email:
              assinatura.payer_email,

            external_reference:
              assinatura.external_reference
          }
        );

        return;
      }

      if (
        tipo ===
        'payment'
      ) {
        const pagamento =
          await mpGet(
            `/v1/payments/${encodeURIComponent(dataId)}`
          );

        console.log(
          'MP pagamento atualizado:',
          {
            id:
              pagamento.id,

            status:
              pagamento.status,

            external_reference:
              pagamento.external_reference,

            transaction_amount:
              pagamento.transaction_amount,

            payment_method_id:
              pagamento.payment_method_id
          }
        );

        return;
      }

      if (
        tipo ===
        'subscription_authorized_payment'
      ) {
        const fatura =
          await mpGet(
            `/authorized_payments/${encodeURIComponent(dataId)}`
          );

        console.log(
          'MP fatura de assinatura atualizada:',
          {
            id:
              fatura.id,

            status:
              fatura.status,

            preapproval_id:
              fatura.preapproval_id
          }
        );

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
        erro.dados || erro
      );
    }
  }
);


/* ==========================================
   PORTA DO SERVIDOR
========================================== */

const PORT =
  process.env.PORT ||
  3000;

if (
  require.main === module
) {
  app.listen(
    PORT,
    () =>
      console.log(
        `AYRO ACM API PRECISAO-V12-MP rodando na porta ${PORT}`
      )
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
