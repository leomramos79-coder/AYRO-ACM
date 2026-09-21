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

  let m;  while ((m = re.exec(html))) {
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
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        ' '
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        ' '
      )
      .replace(
        /<[^>]+>/g,
        ' '
      )
      .replace(
        /&nbsp;|&#160;/gi,
        ' '
      )
      .replace(
        /&sup2;|&#178;/gi,
        '²'
      )
      .replace(
        /&quot;/gi,
        '"'
      )
      .replace(
        /&amp;/gi,
        '&'
      )
      .replace(
        /\s+/g,
        ' '
      );

  const precos = precosNoTexto(clean);
  const areas = areasNoTexto(clean);
  const quartos = quartosNoTexto(clean);

  const structured = {
    precos: [],
    areas: [],
    quartos: []
  };

  for (
    const root of extrairJsonLd(html)
  ) {
    caminhar(
      root,
      o => {
        for (
          const [k, v] of Object.entries(o)
        ) {
          if (
            /^(price|lowPrice|highPrice)$/i.test(k)
          ) {
            const n = numeroBR(v);

            if (
              Number.isFinite(n) &&
              n >= 50000
            ) {
              structured.precos.push(n);
            }
          }

          if (
            /floorSize|area|size/i.test(k)
          ) {
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
    .map(
      m => numeroBR(m[1])
    )
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

async function enriquecerPagina(
  item,
  busca
) {
  if (
    !ehLinkIndividual(item.link)
  ) {
    return item;
  }

  const ctrl =
    new AbortController();

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
      r.headers.get(
        'content-type'
      ) || '';

    if (
      !ct.includes('text/html')
    ) {
      return item;
    }

    const html =
      await r.text();

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
    motivos.push('link não é anúncio individual');
  }

  if (!Number.isFinite(preco)) {
    motivos.push('sem preço identificado');
  }

  if (!Number.isFinite(area)) {
    motivos.push('sem área identificada');
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
    motivos.push('tipo de imóvel divergente');
  }

  let diferencaArea = null;

  if (busca.area && area) {
    diferencaArea =
      Math.abs(area - busca.area) /
      busca.area;

    if (diferencaArea > TOLERANCIA_AREA) {
      motivos.push('área fora da faixa');
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
      ? contemTermo(full, busca.bairro)
      : true;

  detalhes.bairro = bairroOk ? 25 : 0;
  score += detalhes.bairro;

  detalhes.tipo = tipoConfere ? 15 : 0;
  score += detalhes.tipo;

  if (busca.area && area) {
    detalhes.area =
      scoreProximidadeNumero(
        busca.area,
        area,
        20,
        0.35
      );
  } else {
    detalhes.area = 0;
  }

  score += detalhes.area;

  if (
    Number.isFinite(busca.quartos) &&
    quartos.length
  ) {
    const melhorQuarto =
      [...quartos].sort(
        (a, b) =>
          Math.abs(a - busca.quartos) -
          Math.abs(b - busca.quartos)
      )[0];

    detalhes.quartos =
      Math.max(
        0,
        7 -
          Math.abs(
            melhorQuarto -
            busca.quartos
          ) * 3
      );
  } else {
    detalhes.quartos = 0;
  }

  if (
    Number.isFinite(busca.suites) &&
    Number.isFinite(suites)
  ) {
    detalhes.suites =
      Math.max(
        0,
        3 -
          Math.abs(
            suites -
            busca.suites
          ) * 1.5
      );
  } else {
    detalhes.suites = 0;
  }

  score +=
    detalhes.quartos +
    detalhes.suites;

  if (busca.conservacao) {
    detalhes.conservacao =
      conservacao &&
      contemTermo(
        conservacao,
        busca.conservacao
      )
        ? 8
        : 0;
  } else {
    detalhes.conservacao = 0;
  }

  score += detalhes.conservacao;

  if (
    Number.isFinite(busca.vagas) &&
    Number.isFinite(vagas)
  ) {
    detalhes.vagas =
      Math.max(
        0,
        5 -
          Math.abs(
            vagas -
            busca.vagas
          ) * 2
      );
  } else {
    detalhes.vagas = 0;
  }

  score += detalhes.vagas;

  if (
    Number.isFinite(busca.condominio) &&
    Number.isFinite(condominio)
  ) {
    detalhes.condominio =
      scoreProximidadeNumero(
        busca.condominio,
        condominio,
        4,
        0.50
      );
  } else {
    detalhes.condominio = 0;
  }

  score += detalhes.condominio;

  detalhes.lazer = 0;

  if (busca.piscina) {
    detalhes.lazer +=
      piscina ? 1.5 : 0;
  }

  if (busca.sauna) {
    detalhes.lazer +=
      sauna ? 1.5 : 0;
  }

  score += detalhes.lazer;

  detalhes.diferenciais =
    busca.diferenciais &&
    contemTermo(
      full,
      busca.diferenciais
    )
      ? 3
      : 0;

  score += detalhes.diferenciais;

  score =
    Math.max(
      0,
      Math.min(100, score)
    );

  const comparavelValido =
    motivos.length === 0 &&
    Number.isFinite(preco) &&
    Number.isFinite(area) &&
    Number.isFinite(precoM2);

  return {
    titulo,
    descricao,
    link: normalizarLink(link),

    fonte:
      item.source ||
      (() => {
        try {
          return new URL(link).hostname;
        } catch {
          return '';
        }
      })(),

    preco,
    area,

    quartos:
      quartos.length
        ? quartos[0]
        : null,

    suites,
    vagas,
    condominio,
    piscina,
    sauna,
    conservacao,

    preco_m2: precoM2,

    score_similaridade:
      Math.round(score * 10) / 10,

    detalhes_score: detalhes,

    comparavel_valido:
      comparavelValido,

    motivos_exclusao: motivos,

    diferenca_area:
      diferencaArea
  };
}function removerOutliers(
  comparaveis
) {
  if (
    !Array.isArray(comparaveis) ||
    comparaveis.length < 5
  ) {
    return comparaveis || [];
  }

  const valores =
    comparaveis
      .map(x => x.preco_m2)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

  if (valores.length < 5) {
    return comparaveis;
  }

  const q1 =
    valores[
      Math.floor(
        (valores.length - 1) * 0.25
      )
    ];

  const q3 =
    valores[
      Math.floor(
        (valores.length - 1) * 0.75
      )
    ];

  const iqr = q3 - q1;

  const minimo =
    q1 - 1.5 * iqr;

  const maximo =
    q3 + 1.5 * iqr;

  const filtrados =
    comparaveis.filter(
      x =>
        x.preco_m2 >= minimo &&
        x.preco_m2 <= maximo
    );

  return filtrados.length >= 3
    ? filtrados
    : comparaveis;
}

function calcularAvaliacao(
  comparaveis,
  areaAlvo
) {
  if (
    !Array.isArray(comparaveis) ||
    comparaveis.length <
      MIN_COMPARAVEIS ||
    !Number.isFinite(areaAlvo) ||
    areaAlvo <= 0
  ) {
    return {
      disponivel: false,

      motivo:
        `São necessários pelo menos ${MIN_COMPARAVEIS} imóveis comparáveis reais com preço e área para calcular a avaliação.`,

      quantidade:
        Array.isArray(comparaveis)
          ? comparaveis.length
          : 0
    };
  }

  const usados =
    removerOutliers(
      comparaveis
    );

  const valoresM2 =
    usados
      .map(x => x.preco_m2)
      .filter(Number.isFinite);

  if (
    valoresM2.length <
    MIN_COMPARAVEIS
  ) {
    return {
      disponivel: false,

      motivo:
        'Não há comparáveis suficientes após a validação estatística.',

      quantidade:
        valoresM2.length
    };
  }

  const medianaM2 =
    mediana(valoresM2);

  let somaPesos = 0;
  let somaPonderada = 0;

  for (const item of usados) {
    if (
      !Number.isFinite(
        item.preco_m2
      )
    ) {
      continue;
    }

    const peso =
      Math.max(
        0.25,
        (
          Number(
            item.score_similaridade
          ) || 0
        ) / 100
      );

    somaPesos += peso;

    somaPonderada +=
      item.preco_m2 *
      peso;
  }

  const ponderadoM2 =
    somaPesos
      ? somaPonderada /
        somaPesos
      : media(valoresM2);

  const precoM2Referencia =
    medianaM2 &&
    ponderadoM2
      ? (
          medianaM2 * 0.55 +
          ponderadoM2 * 0.45
        )
      : (
          medianaM2 ||
          ponderadoM2
        );

  const valorMercado =
    precoM2Referencia *
    areaAlvo;

  const valorVendaRapida =
    valorMercado * 0.94;

  const valorMaximo =
    valorMercado * 1.06;

  return {
    disponivel: true,

    quantidade:
      usados.length,

    preco_m2_mediano:
      Math.round(
        medianaM2
      ),

    preco_m2_ponderado:
      Math.round(
        ponderadoM2
      ),

    preco_m2_referencia:
      Math.round(
        precoM2Referencia
      ),

    valor_venda_rapida:
      Math.round(
        valorVendaRapida
      ),

    valor_mercado:
      Math.round(
        valorMercado
      ),

    valor_maximo_sugerido:
      Math.round(
        valorMaximo
      ),

    formatado: {
      venda_rapida:
        moeda(
          valorVendaRapida
        ),

      mercado:
        moeda(
          valorMercado
        ),

      maximo_sugerido:
        moeda(
          valorMaximo
        )
    },

    metodologia:
      'Mediana do preço por m² combinada com média ponderada pela similaridade dos comparáveis, com remoção de outliers quando há amostra suficiente.'
  };
}

function cacheGet(key) {
  const x =
    searchCache.get(key);

  if (!x) return null;

  if (
    Date.now() - x.ts >
    CACHE_TTL_MS
  ) {
    searchCache.delete(key);
    return null;
  }

  return x.value;
}

function cacheSet(
  key,
  value
) {
  if (
    searchCache.size >=
    CACHE_MAX
  ) {
    const primeiro =
      searchCache.keys().next().value;

    searchCache.delete(
      primeiro
    );
  }

  searchCache.set(
    key,
    {
      ts: Date.now(),
      value
    }
  );
}

async function buscarSerpApi(
  q,
  num = 20
) {
  const key =
    process.env.SERPAPI_KEY;

  if (!key) {
    throw new Error(
      'SERPAPI_KEY não configurada no Render.'
    );
  }

  const u =
    new URL(
      'https://serpapi.com/search.json'
    );

  u.searchParams.set(
    'engine',
    'google'
  );

  u.searchParams.set(
    'q',
    q
  );

  u.searchParams.set(
    'gl',
    'br'
  );

  u.searchParams.set(
    'hl',
    'pt-br'
  );

  u.searchParams.set(
    'num',
    String(num)
  );

  u.searchParams.set(
    'api_key',
    key
  );

  const ctrl =
    new AbortController();

  const timer =
    setTimeout(
      () => ctrl.abort(),
      10000
    );

  try {
    const r =
      await fetch(
        u,
        {
          signal: ctrl.signal,

          headers: {
            'user-agent': UA
          }
        }
      );

    if (!r.ok) {
      throw new Error(
        `SerpAPI HTTP ${r.status}`
      );
    }

    const data =
      await r.json();

    const organic =
      Array.isArray(
        data.organic_results
      )
        ? data.organic_results
        : [];

    return organic.map(
      x => ({
        title:
          x.title || '',

        snippet:
          x.snippet || '',

        link:
          x.link || '',

        source:
          x.source || ''
      })
    );
  } finally {
    clearTimeout(timer);
  }
}

function consultasParaBusca(
  q,
  busca
) {
  const base =
    String(q || '').trim();

  const tipo =
    busca.tipo || 'imóvel';

  const cidade =
    busca.cidade || '';

  const bairro =
    busca.bairro || '';

  const quartos =
    busca.quartos
      ? `${busca.quartos} quartos`
      : '';

  const area =
    busca.area
      ? `${Math.round(busca.area)} m²`
      : '';

  const local =
    [bairro, cidade]
      .filter(Boolean)
      .join(' ');

  return [
    base,

    `${tipo} ${quartos} ${area} ${local} venda`,

    `${tipo} ${local} venda site:chavesnamao.com.br`,

    `${tipo} ${local} venda site:imovelweb.com.br`,

    `${tipo} ${local} venda site:vivareal.com.br`,

    `${tipo} ${local} venda site:zapimoveis.com.br`
  ]
    .map(
      x =>
        x.replace(
          /\s+/g,
          ' '
        ).trim()
    )
    .filter(Boolean)
    .filter(
      (x, i, arr) =>
        arr.indexOf(x) === i
    );
}

async function mapLimit(
  arr,
  limit,
  fn
) {
  const out =
    new Array(arr.length);

  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;

      if (
        i >= arr.length
      ) {
        return;
      }

      out[i] =
        await fn(
          arr[i],
          i
        );
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            limit,
            arr.length
          )
      },
      worker
    )
  );

  return out;
}

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      app: 'AYRO ACM API',
      versao:
        'PRECISAO-V12-MP'
    });
  }
);

app.get(
  '/api/health',
  (req, res) => {
    res.json({
      ok: true,
      app: 'AYRO ACM API',
      versao:
        'PRECISAO-V12-MP'
    });
  }
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
              'Informe o parâmetro q.'
          });
      }

      const busca =
        dadosDaBusca(
          q,
          req.query
        );

      const cacheKey =
        JSON.stringify({
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

      const consultas =
        consultasParaBusca(
          q,
          busca
        );

      const porLink =
        new Map();

      const errosBusca = [];

      for (
        const consulta
        of consultas
      ) {
        try {
          const itens =
            await buscarSerpApi(
              consulta,
              20
            );

          for (
            const item of itens
          ) {
            if (
              !item.link
            ) {
              continue;
            }

            const link =
              normalizarLink(
                item.link
              );

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
        } catch (e) {
          errosBusca.push(
            {
              consulta,

              erro:
                e.message ||
                String(e)
            }
          );
        }
      }

      const candidatos =
        [...porLink.values()];

      const individuais =
        candidatos.filter(
          x =>
            ehLinkIndividual(
              x.link
            )
        );

      const enriquecer =
        individuais.slice(
          0,
          18
        );

      const enriquecidos =
        await mapLimit(
          enriquecer,
          4,
          item =>
            enriquecerPagina(
              item,
              busca
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

        erros_busca: errosBusca,

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
        'ERRO AYRO:',
        e
      );

      res
        .status(500)
        .json({
          erro:
            'Erro interno na pesquisa.',

          detalhe:
            e.message ||
