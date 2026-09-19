const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const MIN_COMPARAVEIS = 3;
const MAX_COMPARAVEIS = 10;
const TOLERANCIA_AREA = 0.30;
const FETCH_TIMEOUT_MS = 6500;

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

function dadosDaBusca(q) {
  const nq = norm(q);

  const tipo =
    /apartamento|\bapto\b|flat|studio/.test(nq)
      ? 'apartamento'
      : /\bcasa\b|sobrado/.test(nq)
      ? 'casa'
      : '';

  const qm = nq.match(
    /(\d+)\s*(?:quartos?|dormitorios?|dorms?|qtos?)/i
  );

  const am = nq.match(
    /(\d+(?:[.,]\d+)?)\s*m(?:²|2)(?![a-z0-9])/i
  );

  return {
    tipo,
    quartos: qm ? Number(qm[1]) : null,
    area: am ? numeroBR(am[1]) : null
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

  for (
    const m of
    String(texto).match(
      /R\$\s*[0-9]{2,3}(?:[.\s][0-9]{3})*(?:,[0-9]{2})?|R\$\s*[0-9]{5,9}/gi
    ) || []
  ) {
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
      x => caminhar(x, fn, depth + 1)
    );

    return;
  }

  if (typeof obj === 'object') {
    fn(obj);

    Object.values(obj).forEach(
      x => caminhar(x, fn, depth + 1)
    );
  }
}

function extrairDaPagina(html, busca) {
  const clean = String(html || '')
    .replace(
      /<script[\s\S]*?<\/script>/gi,
      ' '
    )
    .replace(
      /<style[\s\S]*?<\/style>/gi,
      ' '
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(
      /&nbsp;|&#160;/gi,
      ' '
    )
    .replace(
      /&sup2;|&#178;/gi,
      '²'
    )
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');

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
    const root of
    extrairJsonLd(html)
  ) {
    caminhar(root, o => {
      for (
        const [k, v] of
        Object.entries(o)
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
    });
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

    texto:
      clean.slice(0, 20000)
  };
}

async function enriquecerPagina(
  item,
  busca
) {
  if (!ehLinkIndividual(item.link)) {
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

            'accept':
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

  const motivos = [];

  if (
    !ehLinkIndividual(link)
  ) {
    motivos.push(
      'link não é anúncio individual'
    );
  }

  if (
    !Number.isFinite(preco)
  ) {
    motivos.push(
      'sem preço identificado'
    );
  }

  if (
    !Number.isFinite(area)
  ) {
    motivos.push(
      'sem área identificada'
    );
  }

  const textoTipo =
    norm(
      `${texto} ${pg.texto || ''}`
    );

  const temApto =
    /apartamento|\bapto\b|flat|studio/.test(
      textoTipo
    );

  const temCasa =
    /\bcasa\b|sobrado/.test(
      textoTipo
    );

  if (
    busca.tipo === 'apartamento' &&
    temCasa &&
    !temApto
  ) {
    motivos.push(
      'tipo de imóvel divergente'
    );
  }

  if (
    busca.tipo === 'casa' &&
    temApto &&
    !temCasa
  ) {
    motivos.push(
      'tipo de imóvel divergente'
    );
  }

  if (
    busca.quartos &&
    quartos.length &&
    !quartos.includes(
      busca.quartos
    )
  ) {
    motivos.push(
      'quantidade de quartos divergente'
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

  let score = 20;

  if (
    busca.quartos &&
    quartos.includes(
      busca.quartos
    )
  ) {
    score += 30;
  }

  if (
    Number.isFinite(
      diferencaArea
    )
  ) {
    score += Math.max(
      0,
      40 * (
        1 -
        diferencaArea /
        TOLERANCIA_AREA
      )
    );
  }

  if (precoM2) {
    score += 10;
  }

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
        ? `R$ ${Math.round(preco).toLocaleString('pt-BR')}`
        : '',

    area:
      Number.isFinite(area)
        ? `${String(area).replace('.', ',')} m²`
        : '',

    preco_valor:
      preco,

    area_valor:
      area,

    preco_m2:
      precoM2,

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

      diferencaArea
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

        erro:
          String(d.error),

        fatal:
          /invalid api key|unauthorized|credits|account|rate limit/i
            .test(
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
        (v.length - 1) *
        .25
      )
    ];

  const q3 =
    v[
      Math.floor(
        (v.length - 1) *
        .75
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

  const m2s =
    base
      .map(
        x => x.preco_m2
      )
      .filter(
        Number.isFinite
      );

  const med =
    mediana(m2s);

  const avg =
    media(m2s);

  if (!med) {
    return {
      calculada: false,

      motivo:
        'Não foi possível calcular o valor por m².'
    };
  }

  const mercado =
    med * area;

  const rapida =
    mercado * .95;

  const maximo =
    mercado * 1.05;

  return {
    calculada: true,

    metodologia:
      'Mediana do preço por m² de anúncios individuais validados. Quando possível, preço, área e quartos são confirmados na própria página do anúncio.',

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

app.get(
  '/',
  (req, res) =>
    res.json({
      status:
        'AYRO ACM API online',

      versao:
        'PRECISAO-V9',

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
        dadosDaBusca(q);

      const vistos =
        new Set();

      const candidatos = [];

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

      const consultas = [
        `site:imovelweb.com.br/propriedades ${semArea} venda`,

        `site:chavesnamao.com.br/imovel ${semArea} venda`,

        `site:vivareal.com.br/imovel ${semArea} venda`,

        `site:zapimoveis.com.br/imovel ${semArea} venda`,

        `${semArea} "Teresópolis" imóvel venda preço`,

        `${semArea} imóvel venda R$`
      ];

      const erros_busca = [];

      for (
        const consulta of
        [...new Set(consultas)]
      ) {
        const t =
          await buscarSerp(
            apiKey,
            consulta,
            20
          );

        if (t.erro) {
          erros_busca.push({
            consulta,
            erro:
              t.erro
          });
        }

        if (
          t.fatal &&
          candidatos.length === 0
        ) {
          return res
            .status(502)
            .json({
              erro:
                'Falha na SerpApi.',

              detalhe:
                t.erro,

              versao:
                'PRECISAO-V9'
            });
        }

        for (
          const raw of
          t.resultados
        ) {
          if (!raw.link) {
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

          candidatos.push(raw);
        }

        if (
          candidatos.filter(
            x =>
              ehLinkIndividual(
                x.link
              )
          ).length >= 12
        ) {
          break;
        }
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
            16
          );

      const enriquecidos = [];

      for (
        let i = 0;
        i < individuais.length;
        i += 4
      ) {
        const lote =
          individuais.slice(
            i,
            i + 4
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
            )
            .length >= 8
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

      res.json({
        sucesso: true,

        versao:
          'PRECISAO-V9',

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
      });

    } catch (e) {
      console.error(
        'ERRO AYRO V9:',
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
            'PRECISAO-V9'
        });
    }
  }
);

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
        `AYRO ACM API PRECISAO-V9 rodando na porta ${PORT}`
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
