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
  const v = a
    .filter(Number.isFinite)
    .sort((x, y) => x - y);

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

    cidade:
      String(params.cidade || '').trim(),

    bairro:
      String(params.bairro || '').trim(),

    quartos:
      num(params.quartos) ??
      (qm ? Number(qm[1]) : null),

    suites:
      num(params.suites),

    vagas:
      num(params.vagas),

    area:
      num(params.area) ??
      (am ? numeroBR(am[1]) : null),

    condominio:
      num(params.condominio),

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
    quartos:
      q ? Number(q[1]) : null,

    area:
      a ? numeroBR(a[1]) : null,

    preco:
      p ? numeroBR(p[1]) : null
  };
}

function ehLinkIndividual(link = '') {
  const l =
    String(link || '').toLowerCase();

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

  const piscina =
    /\bpiscina\b/.test(t);

  const sauna =
    /\bsauna\b/.test(t);

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
      const x =
        JSON.parse(m[1].trim());

      dados.push(
        ...(Array.isArray(x) ? x : [x])
      );
    } catch {}
  }

  return dados;
}

function caminhar(
  obj,
  fn,
  depth = 0
) {
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
}function extrairDaPagina(html, busca) {
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

  const precos =
    precosNoTexto(clean);

  const areas =
    areasNoTexto(clean);

  const quartos =
    quartosNoTexto(clean);

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

            const n =
              numeroBR(val);

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
            const n =
              Number(v);

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
      : true;

  detalhes.bairro =
    bairroOk ? 25 : 0;

  score +=
    detalhes.bairro;

  detalhes.tipo =
    tipoConfere ? 15 : 0;

  score +=
    detalhes.tipo;

  if (
    busca.area &&
    area
  ) {
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

  score +=
    detalhes.area;

  if (
    Number.isFinite(busca.quartos) &&
    quartos.length
  ) {
    const melhorQuarto =
      [...quartos].sort(
        (a, b) =>
          Math.abs(
            a - busca.quartos
          ) -
          Math.abs(
            b - busca.quartos
          )
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

  if (
    busca.conservacao
  ) {
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

  score +=
    detalhes.conservacao;

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

  score +=
    detalhes.vagas;

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

  score +=
    detalhes.condominio;

  detalhes.lazer = 0;

  if (
    busca.piscina
  ) {
    detalhes.lazer +=
      piscina ? 1.5 : 0;
  }

  if (
    busca.sauna
  ) {
    detalhes.lazer +=
      sauna ? 1.5 : 0;
  }

  score +=
    detalhes.lazer;

  detalhes.diferenciais =
    busca.diferenciais &&
    contemTermo(
      full,
      busca.diferenciais
    )
      ? 3
      : 0;

  score +=
    detalhes.diferenciais;

  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  const comparavelValido =
    motivos.length === 0 &&
    Number.isFinite(preco) &&
    Number.isFinite(area) &&
    Number.isFinite(precoM2);

  return {
    titulo,
    descricao,

    link:
      normalizarLink(link),

    fonte:
      item.source ||
      (() => {
        try {
          return new URL(
            link
          ).hostname;
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

    preco_m2:
      precoM2,

    score_similaridade:
      Math.round(
        score * 10
      ) / 10,

    detalhes_score:
      detalhes,

    comparavel_valido:
      comparavelValido,

    motivos_exclusao:
      motivos,

    diferenca_area:
      diferencaArea
  };
}

function removerOutliers(
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
}async function buscarSerpApi(
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

  u.searchParams.set('engine', 'google');
  u.searchParams.set('q', q);
  u.searchParams.set('gl', 'br');
  u.searchParams.set('hl', 'pt-br');
  u.searchParams.set('num', String(num));
  u.searchParams.set('api_key', key);

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
          errosBusca.push({
            consulta,

            erro:
              e.message ||
              String(e)
          });
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

/* ==========================================
   DIAGNÓSTICO SEGURO DE CONFIGURAÇÃO
   Não mostra nenhuma senha ou token
========================================== */

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
      !!process.env.MP_WEBHOOK_SECRET
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

async function mpGet(path) {
  return mpRequest(
    path,
    {
      method: 'GET'
    }
  );
}

async function supabaseRequest(
  path,
  options = {}
) {
  const url =
    supabaseUrl();

  const secret =
    supabaseSecret();

  console.log(
    'SUPABASE REQUEST CHECK:',
    {
      url: !!url,
      secret: !!secret
    }
  );

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
    const erro =
      new Error(
        `Supabase HTTP ${resposta.status}`
      );

    erro.dados =
      dados;

    throw erro;
  }

  return dados;
}

async function supabaseAuthRequest(
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
}async function buscarUsuarioAuthPorEmail(
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

/* ==========================================
   CRIAR ACESSO E ENVIAR LINK DE SENHA
========================================== */

async function garantirUsuarioAuthParaEmail(email) {
  let user =
    await buscarUsuarioAuthPorEmail(
      email
    );

  if (user?.id) {
    return user;
  }

  // Cria uma senha temporária aleatória.
  // Ela nunca é mostrada ao cliente.
  // O cliente criará a própria senha pelo e-mail.
  const senhaTemporaria =
    crypto
      .randomBytes(32)
      .toString('hex');

  const criado =
    await supabaseAuthRequest(
      '/auth/v1/admin/users',
      {
        method: 'POST',

        body:
          JSON.stringify({
            email,

            password:
              senhaTemporaria,

            email_confirm:
              true,

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

function ayroAppUrl() {
  return String(
    process.env.APP_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ''
  ).replace(/\/$/, '');
}

async function enviarEmailCriarSenha(
  email
) {
  const redirectTo =
    ayroAppUrl();

  if (!redirectTo) {
    throw new Error(
      'APP_URL não configurada no Render.'
    );
  }

  await supabaseAuthRequest(
    '/auth/v1/recover',
    {
      method: 'POST',

      body:
        JSON.stringify({
          email,

          redirect_to:
            redirectTo
        })
    }
  );

  console.log(
    'E-mail para criação de senha solicitado ao Supabase:',
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
}async function buscarAssinaturaPorReferencia(
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
              'pending'
          }
        );
      }

      return res.json({
        ok: true,

        subscription_id:
          assinatura.id || null,

        status:
          assinatura.status ||
          'pending',

        external_reference:
          externalReference,

        init_point:
          assinatura.init_point || null
      });

    } catch (erro) {
      console.error(
        'Erro ao criar assinatura Mercado Pago:',
        erro?.dados || erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível criar a assinatura.',

          detalhe:
            erro?.dados?.message ||
            erro.message ||
            String(erro)
        });
    }
  }
);/* ==========================================
   PIX — R$ 49,90 / 30 DIAS
========================================== */

app.post(
  '/api/mercadopago/criar-pix',
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email || ''
        )
          .trim()
          .toLowerCase();

      if (!email) {
        return res
          .status(400)
          .json({
            erro:
              'Informe o e-mail para gerar o Pix.'
          });
      }

      const emailValido =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          email
        );

      if (!emailValido) {
        return res
          .status(400)
          .json({
            erro:
              'Informe um e-mail válido.'
          });
      }

      const externalReference =
        `AYRO-PIX-${crypto.randomUUID()}`;

      const agora =
        new Date().toISOString();

      /*
       * Primeiro registramos no Supabase
       * qual e-mail está comprando o acesso.
       *
       * O external_reference será a ligação
       * entre o pagamento do Mercado Pago
       * e o cliente do AYRO.
       */

      const criadas =
        await supabaseRequest(
          '/rest/v1/ayro_assinaturas',
          {
            method:
              'POST',

            body:
              JSON.stringify({
                user_id:
                  null,

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

                mercado_pago_payment_id:
                  null,

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

      const registro =
        Array.isArray(criadas) &&
        criadas.length
          ? criadas[0]
          : null;

      if (!registro?.id) {
        throw new Error(
          'Não foi possível registrar a compra no Supabase.'
        );
      }

      /*
       * Criamos o pagamento Pix.
       *
       * IMPORTANTE:
       * O AYRO usa external_reference para
       * identificar a compra.
       *
       * Não usamos o e-mail da conta do
       * Mercado Pago como identificação
       * principal do cliente.
       */

      const pagamento =
        await mpRequest(
          '/v1/payments',
          {
            method:
              'POST',

            headers: {
              'X-Idempotency-Key':
                crypto.randomUUID()
            },

            body:
              JSON.stringify({
                transaction_amount:
                  49.90,

                description:
                  'AYRO ACM Pro - 30 dias',

                payment_method_id:
                  'pix',

                external_reference:
                  externalReference,

                payer: {
                  email
                }
              })
          }
        );

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

      const transactionData =
        pagamento
          ?.point_of_interaction
          ?.transaction_data || {};

      return res.json({
        ok:
          true,

        payment_id:
          String(
            pagamento.id || ''
          ),

        status:
          pagamento.status ||
          'pending',

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
          null,

        valor:
          49.90
      });

    } catch (erro) {
      console.error(
        'Erro ao criar Pix:',
        erro?.dados || erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível gerar o Pix.',

          detalhe:
            erro?.dados?.message ||
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
        await mpGet(
          `/v1/payments/${encodeURIComponent(paymentId)}`
        );

      /*
       * Se o Mercado Pago já confirmou,
       * processamos também aqui.
       *
       * Assim o sistema não depende somente
       * do webhook para liberar o cliente.
       */

      if (
        String(
          pagamento?.status || ''
        ).toLowerCase() ===
        'approved'
      ) {
        try {
          await processarPagamento(
            paymentId
          );
        } catch (erroProcessamento) {
          console.error(
            'Erro ao processar pagamento aprovado durante consulta:',
            erroProcessamento?.dados ||
            erroProcessamento
          );
        }
      }

      return res.json({
        ok:
          true,

        payment_id:
          String(
            pagamento.id || ''
          ),

        status:
          pagamento.status ||
          'unknown',

        status_detail:
          pagamento.status_detail ||
          null,

        payment_method_id:
          pagamento.payment_method_id ||
          null,

        external_reference:
          pagamento.external_reference ||
          null
      });

    } catch (erro) {
      console.error(
        'Erro ao consultar pagamento:',
        erro?.dados || erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível consultar o pagamento.',

          detalhe:
            erro?.dados?.message ||
            erro.message ||
            String(erro)
        });
    }
  }
);async function processarPreapproval(
  dataId
) {
  const assinatura =
    await mpGet(
      `/preapproval/${encodeURIComponent(dataId)}`
    );

  let registro =
    await buscarAssinaturaPorReferencia(
      assinatura.external_reference
    );

  if (!registro) {
    registro =
      await buscarAssinaturaPorSubscriptionId(
        assinatura.id
      );
  }

  if (!registro) {
    console.log(
      'Assinatura MP sem registro correspondente:',
      assinatura.id
    );

    return;
  }

  const status =
    String(
      assinatura.status || ''
    ).toLowerCase();

  const ativa =
    [
      'authorized',
      'active'
    ].includes(status);

  const encerrada =
    [
      'cancelled',
      'canceled',
      'paused'
    ].includes(status);

  const acessoInicio =
    ativa
      ? (
          registro.acesso_inicio ||
          new Date().toISOString()
        )
      : registro.acesso_inicio;

  const acessoFim =
    ativa
      ? (
          assinatura.next_payment_date ||
          registro.acesso_fim ||
          null
        )
      : registro.acesso_fim;

  await atualizarAssinatura(
    registro.id,
    {
      status:
        assinatura.status ||
        registro.status,

      metodo_pagamento:
        'cartao_assinatura',

      mercado_pago_subscription_id:
        String(
          assinatura.id || ''
        ),

      acesso_inicio:
        acessoInicio ||
        null,

      acesso_fim:
        acessoFim ||
        null,

      proximo_pagamento:
        assinatura.next_payment_date ||
        null
    }
  );

  if (registro.user_id) {
    if (ativa) {
      await atualizarProfile(
        registro.user_id,
        'active',
        acessoFim || null
      );
    }

    if (encerrada) {
      await atualizarProfile(
        registro.user_id,
        'inactive',
        acessoFim || null
      );
    }
  }
}

/* ==========================================
   PROCESSAR PAGAMENTO
========================================== */

async function processarPagamento(
  dataId
) {
  const pagamento =
    await mpGet(
      `/v1/payments/${encodeURIComponent(dataId)}`
    );

  const ref =
    pagamento.external_reference;

  if (!ref) {
    console.log(
      'Pagamento sem external_reference:',
      pagamento.id
    );

    return;
  }

  const registro =
    await buscarAssinaturaPorReferencia(
      ref
    );

  if (!registro) {
    console.log(
      'Pagamento MP sem registro correspondente:',
      pagamento.id
    );

    return;
  }

  const status =
    String(
      pagamento.status || ''
    ).toLowerCase();

  const metodo =
    String(
      pagamento.payment_method_id || ''
    ).toLowerCase();

  const valor =
    Number(
      pagamento.transaction_amount
    );

  /*
    PIX:
    Só libera quando:
    - aprovado
    - realmente Pix
    - exatamente R$ 49,90
  */

  if (
    status === 'approved' &&
    metodo === 'pix' &&
    Math.abs(
      valor - 49.90
    ) < 0.01
  ) {

    /*
      IDEMPOTÊNCIA:
      Se este payment_id já foi processado,
      não acrescenta outros 30 dias.
    */

    if (
      String(
        registro.mercado_pago_payment_id ||
        ''
      ) ===
        String(
          pagamento.id ||
          ''
        ) &&
      String(
        registro.status ||
        ''
      ).toLowerCase() ===
        'active' &&
      !!registro.user_id
    ) {
      console.log(
        'Pix já processado anteriormente:',
        pagamento.id
      );

      return;
    }

    const agora =
      new Date();

    const fimAtual =
      registro.acesso_fim
        ? new Date(
            registro.acesso_fim
          )
        : null;

    const base =
      fimAtual &&
      fimAtual > agora
        ? fimAtual
        : agora;

    const mesmoPagamento =
      String(
        registro.mercado_pago_payment_id || ''
      ) ===
      String(
        pagamento.id || ''
      );

    const acessoFim =
      mesmoPagamento &&
      registro.acesso_fim
        ? registro.acesso_fim
        : adicionarDias(
            base,
            30
          );

    /*
      IMPORTANTE:
      Usamos o e-mail salvo no AYRO quando
      o Pix foi criado.

      Não dependemos do e-mail da conta
      Mercado Pago usada para efetuar o
      pagamento.
    */

    const emailCliente =
      String(
        registro.email || ''
      )
        .trim()
        .toLowerCase();

    if (!emailCliente) {
      throw new Error(
        'Assinatura sem e-mail do cliente.'
      );
    }

    /*
      Garante que exista um usuário no
      Supabase Auth.

      Se for cliente novo, cria o usuário
      com uma senha temporária aleatória.

      Essa senha NÃO é mostrada ao cliente.
    */

    const user =
      await garantirUsuarioAuthParaEmail(
        emailCliente
      );

    if (!user?.id) {
      throw new Error(
        'Supabase não retornou o ID do usuário.'
      );
    }

    /*
      ENVIA O E-MAIL.

      O cliente receberá o link para
      criar a própria senha.
    */

    await enviarEmailCriarSenha(
      emailCliente
    );

    /*
      Agora registramos o pagamento como
      ativo e liberamos os 30 dias.
    */

    await atualizarAssinatura(
      registro.id,
      {
        status:
          'active',

        user_id:
          user.id,

        metodo_pagamento:
          'pix',

        mercado_pago_payment_id:
          String(
            pagamento.id || ''
          ),

        acesso_inicio:
          registro.acesso_inicio ||
          agora.toISOString(),

        acesso_fim:
          acessoFim,

        proximo_pagamento:
          null
      }
    );

    /*
      Atualiza/cria o profile do cliente
      como assinatura ativa.
    */

    await garantirProfileAtivo(
      user.id,
      emailCliente,
      acessoFim
    );

    console.log(
      'Pix aprovado. Acesso liberado por 30 dias:',
      pagamento.id
    );

    console.log(
      'E-mail para criação da senha solicitado:',
      emailCliente
    );

    return;
  }

  /*
    Caso o pagamento ainda não esteja
    aprovado, apenas atualizamos o status.
  */

  await atualizarAssinatura(
    registro.id,
    {
      status:
        pagamento.status ||
        registro.status,

      mercado_pago_payment_id:
        String(
          pagamento.id || ''
        ),

      metodo_pagamento:
        metodo ||
        registro.metodo_pagamento ||
        null
    }
  );
}

/* ==========================================
   VALIDAÇÃO DO WEBHOOK MERCADO PAGO
========================================== */function validarAssinaturaWebhook(req) {
  const secret =
    String(
      process.env.MP_WEBHOOK_SECRET || ''
    ).trim();

  /*
    Se o secret ainda não estiver configurado,
    não aceitamos o webhook silenciosamente.
  */
  if (!secret) {
    console.error(
      'MP_WEBHOOK_SECRET não configurado.'
    );

    return false;
  }

  const xSignature =
    String(
      req.headers['x-signature'] || ''
    );

  const xRequestId =
    String(
      req.headers['x-request-id'] || ''
    );

  if (
    !xSignature ||
    !xRequestId
  ) {
    return false;
  }

  const partes = {};

  xSignature
    .split(',')
    .forEach(parte => {
      const [
        chave,
        ...resto
      ] = parte
        .trim()
        .split('=');

      if (chave) {
        partes[chave] =
          resto.join('=');
      }
    });

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

  /*
    Mercado Pago envia o ID do recurso
    normalmente em data.id.
  */

  const dataId =
    String(
      req.query?.['data.id'] ||
      req.body?.data?.id ||
      req.body?.id ||
      ''
    );

  /*
    Manifest usado para validar a assinatura
    enviada pelo Mercado Pago.
  */

  let manifest = '';

  if (dataId) {
    manifest +=
      `id:${dataId.toLowerCase()};`;
  }

  if (xRequestId) {
    manifest +=
      `request-id:${xRequestId};`;
  }

  manifest +=
    `ts:${ts};`;

  const calculado =
    crypto
      .createHmac(
        'sha256',
        secret
      )
      .update(manifest)
      .digest('hex');

  try {
    const a =
      Buffer.from(
        calculado,
        'utf8'
      );

    const b =
      Buffer.from(
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
   WEBHOOK MERCADO PAGO
========================================== */

app.post(
  '/api/mercadopago/webhook',
  async (req, res) => {
    try {
      if (
        !validarAssinaturaWebhook(
          req
        )
      ) {
        console.warn(
          'Webhook Mercado Pago com assinatura inválida.'
        );

        return res
          .status(401)
          .json({
            erro:
              'Assinatura inválida.'
          });
      }

      const body =
        req.body || {};

      const tipo =
        String(
          body.type ||
          body.topic ||
          req.query?.type ||
          req.query?.topic ||
          ''
        ).trim();

      const dataId =
        String(
          body?.data?.id ||
          body.id ||
          req.query?.['data.id'] ||
          req.query?.id ||
          ''
        ).trim();

      console.log(
        'Webhook Mercado Pago:',
        {
          tipo,
          dataId
        }
      );

      /*
        Respondemos 200 rapidamente ao
        Mercado Pago para evitar reenvios
        desnecessários.
      */

      res.sendStatus(200);

      if (!dataId) {
        console.log(
          'Webhook recebido sem ID.'
        );

        return;
      }

      /*
        Assinatura recorrente/cartão
      */

      if (
        tipo ===
          'subscription_preapproval' ||
        tipo ===
          'preapproval'
      ) {
        await processarPreapproval(
          dataId
        );

        return;
      }

      /*
        Pagamento, incluindo Pix
      */

      if (
        tipo === 'payment'
      ) {
        await processarPagamento(
          dataId
        );

        return;
      }

      /*
        Alguns eventos do Mercado Pago podem
        chegar sem o tipo esperado.

        Neste caso tentamos identificar
        o recurso pelo ID.
      */

      try {
        await processarPagamento(
          dataId
        );

        return;

      } catch (
        erroPagamento
      ) {
        console.log(
          'ID não processado como pagamento:',
          dataId
        );
      }

      try {
        await processarPreapproval(
          dataId
        );

      } catch (
        erroAssinatura
      ) {
        console.log(
          'ID não processado como assinatura:',
          dataId
        );
      }

    } catch (erro) {
      /*
        Se o 200 já foi enviado, não tentamos
        enviar uma segunda resposta HTTP.
      */

      console.error(
        'Erro no webhook Mercado Pago:',
        erro?.dados ||
        erro
      );

      if (!res.headersSent) {
        return res
          .status(500)
          .json({
            erro:
              'Erro ao processar webhook.'
          });
      }
    }
  }
);

/* ==========================================
   ATIVAÇÃO PIX / REENVIO DO E-MAIL
========================================== */

app.post(
  '/api/ativar-conta-pix',
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email || ''
        )
          .trim()
          .toLowerCase();

      const paymentId =
        String(
          req.body?.payment_id || ''
        ).trim();

      if (
        !email ||
        !paymentId
      ) {
        return res
          .status(400)
          .json({
            erro:
              'E-mail e pagamento são obrigatórios.'
          });
      }

      /*
        Consultamos diretamente o Mercado Pago.
        Não confiamos apenas na informação
        recebida do navegador.
      */

      const pagamento =
        await mpGet(
          `/v1/payments/${encodeURIComponent(paymentId)}`
        );

      const status =
        String(
          pagamento?.status || ''
        ).toLowerCase();

      const metodo =
        String(
          pagamento?.payment_method_id || ''
        ).toLowerCase();

      const valor =
        Number(
          pagamento?.transaction_amount
        );

      const ref =
        String(
          pagamento?.external_reference || ''
        );

      if (
        status !== 'approved' ||
        metodo !== 'pix' ||
        Math.abs(
          valor - 49.90
        ) >= 0.01 ||
        !ref
      ) {
        return res
          .status(403)
          .json({
            erro:
              'Este Pix ainda não está aprovado.'
          });
      }

      /*
        Procuramos a compra pelo
        external_reference.

        Isso corrige o problema anterior:
        o e-mail da conta do Mercado Pago
        pode ser diferente do e-mail que
        receberá o acesso ao AYRO.
      */

      const registro =
        await buscarAssinaturaPorReferencia(
          ref
        );

      if (!registro) {
        return res
          .status(404)
          .json({
            erro:
              'Compra não encontrada no AYRO.'
          });
      }

      const emailCompra =
        String(
          registro.email || ''
        )
          .trim()
          .toLowerCase();

      if (
        !emailCompra ||
        emailCompra !== email
      ) {
        return res
          .status(403)
          .json({
            erro:
              'O pagamento não corresponde a este e-mail.'
          });
      }

      /*
        Primeiro garante que o pagamento
        esteja processado e que os 30 dias
        estejam liberados.
      */

      await processarPagamento(
        paymentId
      );

      /*
        Garante que exista o usuário Auth.
      */

      const user =
        await garantirUsuarioAuthParaEmail(
          emailCompra
        );

      if (!user?.id) {
        throw new Error(
          'Não foi possível preparar o usuário.'
        );
      }

      /*
        Reenvia o e-mail para criação da senha.

        Isso também permite que o frontend
        ofereça "reenviar e-mail" caso o
        cliente não encontre a primeira
        mensagem.
      */

      await enviarEmailCriarSenha(
        emailCompra
      );

      return res.json({
        ok:
          true,

        email:
          emailCompra,

        status:
          'active',

        mensagem:
          'Pagamento confirmado. Enviamos para seu e-mail o link para criar sua senha.'
      });

    } catch (erro) {
      console.error(
        'Erro ao preparar acesso Pix:',
        erro?.dados ||
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível preparar o acesso.',

          detalhe:
            erro?.dados?.message ||
            erro.message ||
            String(erro)
        });
    }
  }
);/* ==========================================
   CONSULTAR STATUS DA ASSINATURA
========================================== */

app.get(
  '/api/assinatura/status',
  async (req, res) => {
    try {
      const email =
        String(
          req.query?.email || ''
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

      const registro =
        await buscarAssinaturaPorEmail(
          email
        );

      if (!registro) {
        return res.json({
          ok: true,
          assinatura: false,
          status: 'inactive',
          ativa: false
        });
      }

      const agora =
        new Date();

      const acessoFim =
        registro.acesso_fim
          ? new Date(
              registro.acesso_fim
            )
          : null;

      const status =
        String(
          registro.status || ''
        ).toLowerCase();

      const ativa =
        status === 'active' &&
        acessoFim &&
        acessoFim > agora;

      return res.json({
        ok: true,

        assinatura: true,

        ativa:
          !!ativa,

        status:
          ativa
            ? 'active'
            : status || 'inactive',

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
          null,

        proximo_pagamento:
          registro.proximo_pagamento ||
          null
      });

    } catch (erro) {
      console.error(
        'Erro ao consultar assinatura:',
        erro?.dados || erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível consultar a assinatura.',

          detalhe:
            erro?.dados?.message ||
            erro.message ||
            String(erro)
        });
    }
  }
);

/* ==========================================
   VALIDAR ACESSO DO USUÁRIO
========================================== */

app.post(
  '/api/assinatura/validar',
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email || ''
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

      const registro =
        await buscarAssinaturaPorEmail(
          email
        );

      if (!registro) {
        return res.json({
          ok: true,
          ativa: false,
          status: 'inactive'
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
          registro.status || ''
        ).toLowerCase();

      let ativa =
        status === 'active' &&
        fim &&
        fim > agora;

      /*
        Se os 30 dias já terminaram,
        marcamos a assinatura como expirada.
      */

      if (
        status === 'active' &&
        fim &&
        fim <= agora
      ) {
        ativa = false;

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
            'expired',
            registro.acesso_fim ||
            null
          );
        }
      }

      return res.json({
        ok: true,

        ativa:
          !!ativa,

        status:
          ativa
            ? 'active'
            : (
                fim &&
                fim <= agora
                  ? 'expired'
                  : status ||
                    'inactive'
              ),

        acesso_fim:
          registro.acesso_fim ||
          null,

        plano:
          registro.plano ||
          'AYRO ACM Pro'
      });

    } catch (erro) {
      console.error(
        'Erro ao validar assinatura:',
        erro?.dados || erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível validar o acesso.',

          detalhe:
            erro?.dados?.message ||
            erro.message ||
            String(erro)
        });
    }
  }
);

/* ==========================================
   REENVIAR E-MAIL PARA CRIAR SENHA
========================================== */

app.post(
  '/api/reenviar-email-senha',
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email || ''
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

      const registro =
        await buscarAssinaturaPorEmail(
          email
        );

      if (!registro) {
        return res
          .status(404)
          .json({
            erro:
              'Não encontramos uma assinatura para este e-mail.'
          });
      }

      const status =
        String(
          registro.status || ''
        ).toLowerCase();

      const acessoFim =
        registro.acesso_fim
          ? new Date(
              registro.acesso_fim
            )
          : null;

      if (
        status !== 'active' ||
        !acessoFim ||
        acessoFim <= new Date()
      ) {
        return res
          .status(403)
          .json({
            erro:
              'Não existe uma assinatura ativa para este e-mail.'
          });
      }

      /*
        Garante que o usuário exista antes
        de solicitar o e-mail de senha.
      */

      const user =
        await garantirUsuarioAuthParaEmail(
          email
        );

      if (!user?.id) {
        throw new Error(
          'Não foi possível preparar o usuário.'
        );
      }

      /*
        Caso a assinatura ainda não esteja
        ligada ao user_id, fazemos isso aqui.
      */

      if (
        String(
          registro.user_id || ''
        ) !==
        String(
          user.id || ''
        )
      ) {
        await atualizarAssinatura(
          registro.id,
          {
            user_id:
              user.id
          }
        );
      }

      await garantirProfileAtivo(
        user.id,
        email,
        registro.acesso_fim
      );

      await enviarEmailCriarSenha(
        email
      );

      return res.json({
        ok: true,

        mensagem:
          'Enviamos um novo link para seu e-mail.'
      });

    } catch (erro) {
      console.error(
        'Erro ao reenviar e-mail de senha:',
        erro?.dados || erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível reenviar o e-mail.',

          detalhe:
            erro?.dados?.message ||
            erro.message ||
            String(erro)
        });
    }
  }
);/* ==========================================
   VERIFICAR ACESSO DO CLIENTE
========================================== */

app.get(
  '/api/acesso/:email',
  async (req, res) => {
    try {
      const email =
        String(
          req.params.email || ''
        )
          .trim()
          .toLowerCase();

      if (!email) {
        return res
          .status(400)
          .json({
            ativo: false,
            erro: 'E-mail não informado.'
          });
      }

      const registro =
        await buscarAssinaturaPorEmail(
          email
        );

      if (!registro) {
        return res.json({
          ativo: false,
          status: 'sem_assinatura'
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
          registro.status || ''
        ).toLowerCase();

      let ativo = false;

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
        Se o acesso Pix venceu,
        atualizamos o registro.
      */

      if (
        registro.metodo_pagamento ===
          'pix' &&
        status === 'active' &&
        fim &&
        fim <= agora
      ) {
        await atualizarAssinatura(
          registro.id,
          {
            status: 'expired'
          }
        );

        if (registro.user_id) {
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
          ativo: false,

          erro:
            'Não foi possível verificar o acesso.'
        });
    }
  }
);

/* ==========================================
   ROTA PRINCIPAL
========================================== */

app.get(
  '/',
  (req, res) => {
    res.json({
      ok: true,

      sistema:
        'AYRO ACM Pro',

      api:
        'online',

      versao:
        'PRECISAO-V12-MP',

      pagamento: {
        cartao:
          'R$ 49,90/mês',

        pix:
          'R$ 49,90 / 30 dias'
      },

      acesso: {
        fluxo:
          'pagamento-email-senha'
      }
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
