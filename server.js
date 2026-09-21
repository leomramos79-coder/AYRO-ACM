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

  if (
    /novo|lancamento|primeira locacao/.test(t)
  ) {
    conservacao = 'novo';
  } else if (
    /reformad[oa]|renovad[oa]/.test(t)
  ) {
    conservacao = 'reformado';
  } else if (
    /bom estado|bem conservad[oa]/.test(t)
  ) {
    conservacao = 'bom estado';
  } else if (
    /para reformar|precisa reform/.test(t)
  ) {
    conservacao = 'para reformar';
  } else if (
    /usad[oa]/.test(t)
  ) {
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
