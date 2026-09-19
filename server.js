const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const MIN_COMPARAVEIS = 3;
const MAX_COMPARAVEIS = 8;
const TOLERANCIA_AREA = 0.35;

function numeroBR(valor) {
  if (valor === null || valor === undefined || valor === "") return null;

  let s = String(valor)
    .trim()
    .replace(/\s/g, "")
    .replace(/^R\$/i, "");

  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+(,\d+)?$/.test(s)) {
    s = s.replace(",", ".");
  } else {
    s = s.replace(/[^0-9.,]/g, "");

    if (s.includes(",") && s.includes(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.includes(",")) {
      s = s.replace(",", ".");
    }
  }

  const n = Number(s);

  return Number.isFinite(n) ? n : null;
}

function moeda(valor) {
  return Number.isFinite(valor)
    ? valor.toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
        maximumFractionDigits: 0
      })
    : null;
}

function mediana(lista) {
  const v = lista
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!v.length) return null;

  const m = Math.floor(v.length / 2);

  return v.length % 2
    ? v[m]
    : (v[m - 1] + v[m]) / 2;
}

function media(lista) {
  const v = lista.filter(Number.isFinite);

  return v.length
    ? v.reduce((a, b) => a + b, 0) / v.length
    : null;
}

function normalizarLink(link = "") {
  try {
    const u = new URL(link);

    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid"
    ].forEach(k => u.searchParams.delete(k));

    return (u.origin + u.pathname).replace(/\/$/, "");
  } catch {
    return String(link)
      .split("?")[0]
      .replace(/\/$/, "");
  }
}

function dadosDaBusca(q) {
  const tipo =
    /apartamento|apto|flat|studio/i.test(q)
      ? "apartamento"
      : /\bcasa\b|sobrado/i.test(q)
      ? "casa"
      : "";

  const qm =
    q.match(
      /(\d+)\s*(?:quartos?|dormitórios?)/i
    );

  const am =
    q.match(
      /(\d+(?:[.,]\d+)?)\s*m(?:²|2)\b/i
    );

  return {
    tipo,
    quartos: qm
      ? Number(qm[1])
      : null,

    area: am
      ? numeroBR(am[1])
      : null
  };
}

function extrairPreco(texto, item) {
  const candidatos = [];

  if (item.price) {
    candidatos.push(item.price);
  }

  const regex =
    /R\$\s?[\d.]+(?:,\d{2})?/gi;

  const achados =
    texto.match(regex) || [];

  for (const p of achados) {
    candidatos.push(p);
  }

  for (const c of candidatos) {
    const n = numeroBR(c);

    if (
      Number.isFinite(n) &&
      n >= 50000 &&
      n <= 100000000
    ) {
      return {
        texto:
          typeof c === "string"
            ? c
            : String(c),

        valor: n
      };
    }
  }

  return {
    texto: "",
    valor: null
  };
}

function extrairArea(texto) {
  const matches =
    [
      ...texto.matchAll(
        /(\d+(?:[.,]\d+)?)\s*m(?:²|2)\b/gi
      )
    ];

  for (const m of matches) {
    const n = numeroBR(m[1]);

    if (
      Number.isFinite(n) &&
      n >= 15 &&
      n <= 100000
    ) {
      return {
        texto: `${m[1]} m²`,
        valor: n
      };
    }
  }

  return {
    texto: "",
    valor: null
  };
}

function paginaColetiva(
  titulo,
  texto,
  link
) {
  return (
    /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i.test(
      texto
    ) ||

    /imóveis\s+(?:para|à)\s+venda/i.test(
      titulo
    ) ||

    /apartamentos?\s+com\s+\d+\s+quartos?\s+(?:para|à)\s+venda/i.test(
      titulo
    ) ||

    /\/busca|\/imoveis|\/venda\/?$/i.test(
      link || ""
    )
  );
}

function avaliarItem(item, busca) {
  const titulo =
    item.title || "";

  const descricao =
    item.snippet || "";

  const link =
    item.link || "";

  const texto =
    `${titulo} ${descricao}`;

  const p =
    extrairPreco(
      texto,
      item
    );

  const a =
    extrairArea(texto);

  let tipoOk = true;

  if (
    busca.tipo ===
    "apartamento"
  ) {
    tipoOk =
      /apartamento|apto|flat|studio/i.test(
        texto
      ) &&
      !/\bcasa\b|sobrado/i.test(
        texto
      );
  } else if (
    busca.tipo ===
    "casa"
  ) {
    tipoOk =
      /\bcasa\b|sobrado/i.test(
        texto
      ) &&
      !/apartamento|apto|flat|studio/i.test(
        texto
      );
  }

  let quartosOk = true;

  if (busca.quartos) {
    quartosOk =
      new RegExp(
        `\\b${busca.quartos}\\s*(?:quartos?|dormitórios?)`,
        "i"
      ).test(texto);
  }

  let areaOk = true;
  let diferencaArea = null;

  if (
    busca.area &&
    a.valor
  ) {
    diferencaArea =
      Math.abs(
        a.valor -
        busca.area
      ) /
      busca.area;

    areaOk =
      diferencaArea <=
      TOLERANCIA_AREA;
  }

  const social =
    /instagram\.com|facebook\.com|youtube\.com|tiktok\.com/i.test(
      link
    );

  const coletiva =
    paginaColetiva(
      titulo,
      texto,
      link
    );

  const comparavelValido =
    Boolean(link) &&
    Number.isFinite(
      p.valor
    ) &&
    Number.isFinite(
      a.valor
    ) &&
    tipoOk &&
    quartosOk &&
    areaOk &&
    !social &&
    !coletiva;

  let score = 0;

  if (tipoOk) {
    score += 30;
  }

  if (quartosOk) {
    score += 25;
  }

  if (
    Number.isFinite(
      diferencaArea
    )
  ) {
    score +=
      Math.max(
        0,
        35 *
          (
            1 -
            diferencaArea /
              TOLERANCIA_AREA
          )
      );
  } else if (
    !busca.area &&
    a.valor
  ) {
    score += 35;
  }

  if (
    p.valor &&
    a.valor
  ) {
    score += 10;
  }

  const precoM2 =
    p.valor &&
    a.valor
      ? p.valor /
        a.valor
      : null;

  return {
    titulo,
    descricao,
    link,

    fonte:
      item.source ||
      item.displayed_link ||
      "",

    preco:
      p.texto,

    area:
      a.texto,

    preco_valor:
      p.valor,

    area_valor:
      a.valor,

    preco_m2:
      precoM2,

    score_similaridade:
      Math.round(score),

    comparavel_valido:
      comparavelValido,

    diagnostico: {
      tipoOk,
      quartosOk,
      areaOk,
      social,
      paginaColetiva:
        coletiva
    }
  };
}

async function buscarSerp(
  apiKey,
  q,
  num = 20
) {
  const buscaOtimizada =
    q +
    " imóvel à venda anúncio preço R$ m²" +
    " -youtube -instagram -facebook -tiktok";

  const params =
    new URLSearchParams({
      engine: "google",
      q: buscaOtimizada,
      location: "Brazil",
      hl: "pt-br",
      gl: "br",
      num: String(num),
      api_key: apiKey
    });

  const resposta =
    await fetch(
      `https://serpapi.com/search.json?${params.toString()}`
    );

  const dados =
    await resposta.json();

  if (
    !resposta.ok ||
    dados.error
  ) {
    throw new Error(
      dados.error ||
      "Erro ao consultar a SerpApi."
    );
  }

  return (
    dados.organic_results ||
    []
  );
}

function semOutliers(
  comparaveis
) {
  if (
    comparaveis.length <
    4
  ) {
    return comparaveis;
  }

  const valores =
    comparaveis
      .map(
        x =>
          x.preco_m2
      )
      .filter(
        Number.isFinite
      )
      .sort(
        (a, b) =>
          a - b
      );

  const q1 =
    valores[
      Math.floor(
        (valores.length - 1) *
          0.25
      )
    ];

  const q3 =
    valores[
      Math.floor(
        (valores.length - 1) *
          0.75
      )
    ];

  const iqr =
    q3 - q1;

  const min =
    q1 -
    1.5 * iqr;

  const max =
    q3 +
    1.5 * iqr;

  const filtrados =
    comparaveis.filter(
      x =>
        x.preco_m2 >= min &&
        x.preco_m2 <= max
    );

  return (
    filtrados.length >=
    MIN_COMPARAVEIS
      ? filtrados
      : comparaveis
  );
}

function calcularAvaliacao(
  comparaveis,
  areaBusca
) {
  if (
    !areaBusca ||
    comparaveis.length <
      MIN_COMPARAVEIS
  ) {
    return {
      calculada: false,

      motivo:
        !areaBusca
          ? "Informe a área do imóvel na pesquisa para calcular a avaliação."
          : `Foram encontrados apenas ${comparaveis.length} comparáveis válidos. São necessários pelo menos ${MIN_COMPARAVEIS}.`
    };
  }

  const base =
    semOutliers(
      comparaveis
    );

  const precosM2 =
    base
      .map(
        x =>
          x.preco_m2
      )
      .filter(
        Number.isFinite
      );

  const medianaM2 =
    mediana(
      precosM2
    );

  const mediaM2 =
    media(
      precosM2
    );

  if (!medianaM2) {
    return {
      calculada: false,
      motivo:
        "Não foi possível calcular o valor por m²."
    };
  }

  const mercado =
    medianaM2 *
    areaBusca;

  const vendaRapida =
    mercado *
    0.95;

  const valorMaximo =
    mercado *
    1.05;

  return {
    calculada: true,

    metodologia:
      "Mediana do preço por m² dos comparáveis válidos, com remoção de outliers quando há base suficiente.",

    comparaveis_usados:
      base.length,

    area_avaliada_m2:
      areaBusca,

    preco_m2_mediano:
      Math.round(
        medianaM2
      ),

    preco_m2_medio:
      Math.round(
        mediaM2
      ),

    valor_venda_rapida:
      Math.round(
        vendaRapida
      ),

    valor_mercado:
      Math.round(
        mercado
      ),

    valor_maximo_sugerido:
      Math.round(
        valorMaximo
      ),

    valores_formatados: {
      venda_rapida:
        moeda(
          vendaRapida
        ),

      mercado:
        moeda(
          mercado
        ),

      maximo_sugerido:
        moeda(
          valorMaximo
        )
    }
  };
}

app.get(
  "/",
  (req, res) => {
    res.json({
      status:
        "AYRO ACM API online",

      versao:
        "PRECISAO-V4",

      minimo_comparaveis:
        MIN_COMPARAVEIS
    });
  }
);

app.get(
  [
    "/api/pesquisar",
    "/api/search",
    "/search"
  ],

  async (
    req,
    res
  ) => {
    try {
      const q =
        String(
          req.query.q ||
          ""
        ).trim();

      if (!q) {
        return res
          .status(400)
          .json({
            erro:
              "Informe uma pesquisa."
          });
      }

      const apiKey =
        process.env
          .SERPAPI_KEY;

      if (!apiKey) {
        return res
          .status(500)
          .json({
            erro:
              "SERPAPI_KEY não configurada no servidor."
          });
      }

      const busca =
        dadosDaBusca(q);

      let organic =
        await buscarSerp(
          apiKey,
          q,
          20
        );

      let resultados =
        organic.map(
          item =>
            avaliarItem(
              item,
              busca
            )
        );

      let unicos = [];

      const vistos =
        new Set();

      const adicionar =
        lista => {
          for (
            const item
            of lista
          ) {
            if (
              !item.link
            ) {
              continue;
            }

            const chave =
              normalizarLink(
                item.link
              );

            if (
              vistos.has(
                chave
              )
            ) {
              continue;
            }

            vistos.add(
              chave
            );

            unicos.push(
              item
            );
          }
        };

      adicionar(
        resultados
      );

      let comparaveis =
        unicos.filter(
          x =>
            x.comparavel_valido
        );

      /*
       * Se a primeira busca
       * não encontrar pelo menos
       * 3 comparáveis, o AYRO
       * faz uma segunda pesquisa.
       */

      if (
        comparaveis.length <
        MIN_COMPARAVEIS
      ) {
        const q2 =
          q
            .replace(
              /\b\d+(?:[.,]\d+)?\s*m(?:²|2)\b/i,
              ""
            )
            .replace(
              /\s{2,}/g,
              " "
            )
            .trim();

        if (
          q2 &&
          q2 !== q
        ) {
          const organic2 =
            await buscarSerp(
              apiKey,
              q2,
              20
            );

          adicionar(
            organic2.map(
              item =>
                avaliarItem(
                  item,
                  busca
                )
            )
          );

          comparaveis =
            unicos.filter(
              x =>
                x.comparavel_valido
            );
        }
      }

      /*
       * Ordena os imóveis
       * mais semelhantes primeiro.
       */

      comparaveis =
        comparaveis
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
        unicos
          .filter(
            x =>
              !x.comparavel_valido
          )
          .sort(
            (a, b) =>
              b.score_similaridade -
              a.score_similaridade
          );

      /*
       * Calcula o ACM.
       */

      const avaliacao =
        calcularAvaliacao(
          comparaveis,
          busca.area
        );

      res.json({
        sucesso: true,

        versao:
          "PRECISAO-V4",

        consulta:
          q,

        criterios:
          busca,

        total:
          unicos.length,

        total_comparaveis:
          comparaveis.length,

        minimo_comparaveis:
          MIN_COMPARAVEIS,

        comparaveis:
          comparaveis,

        referencias:
          referencias,

        avaliacao:
          avaliacao,

        /*
         * Mantido para
         * compatibilidade
         * com o index.html
         * que já existe.
         */

        resultados: [
          ...comparaveis,
          ...referencias
        ]
      });

    } catch (erro) {
      console.error(
        "ERRO AYRO:",
        erro
      );

      res
        .status(500)
        .json({
          erro:
            "Erro interno na pesquisa.",

          detalhe:
            erro.message ||
            String(erro)
        });
    }
  }
);

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  () => {
    console.log(
      `AYRO ACM API PRECISAO-V4 rodando na porta ${PORT}`
    );
  }
);
