const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "AYRO ACM API online",
    versao: "PRECISAO-V3",
    minimo_comparaveis: 3
  });
});

app.get(
  ["/api/pesquisar", "/api/search", "/search"],
  async (req, res) => {
    try {
      const { q } = req.query;

      if (!q) {
        return res.status(400).json({
          erro: "Informe uma pesquisa."
        });
      }

      const apiKey = process.env.SERPAPI_KEY;

      if (!apiKey) {
        return res.status(500).json({
          erro: "SERPAPI_KEY não configurada no servidor."
        });
      }

      // =========================================
      // PESQUISA OTIMIZADA
      // =========================================

      const buscaOtimizada =
        q +
        " imóvel à venda anúncio" +
        " preço R$" +
        " m²" +
        " -youtube -instagram -facebook -tiktok";

      const url =
        "https://serpapi.com/search.json?engine=google" +
        "&q=" +
        encodeURIComponent(buscaOtimizada) +
        "&location=Brazil" +
        "&hl=pt-br" +
        "&gl=br" +
        "&num=20" +
        "&api_key=" +
        encodeURIComponent(apiKey);

      const resposta = await fetch(url);
      const dados = await resposta.json();

      if (!resposta.ok || dados.error) {
        return res.status(500).json({
          erro:
            dados.error ||
            "Erro ao consultar a SerpApi."
        });
      }

      // =========================================
      // IDENTIFICA TIPO DO IMÓVEL
      // =========================================

      const tipoBusca =
        /apartamento|apto/i.test(q)
          ? "apartamento"
          : /\bcasa\b/i.test(q)
          ? "casa"
          : "";

      // =========================================
      // IDENTIFICA QUANTIDADE DE QUARTOS
      // =========================================

      const quartosMatch =
        q.match(/(\d+)\s*quartos?/i);

      const quartosBusca =
        quartosMatch
          ? Number(quartosMatch[1])
          : null;

      // =========================================
      // IDENTIFICA ÁREA DO IMÓVEL AVALIADO
      // =========================================

      const areaMatch =
        q.match(
          /(\d+(?:[.,]\d+)?)\s*m(?:²|2)/i
        );

      const areaBusca =
        areaMatch
          ? Number(
              areaMatch[1].replace(",", ".")
            )
          : null;

      // =========================================
      // PROCESSA RESULTADOS DO GOOGLE
      // =========================================

      const resultados =
        (dados.organic_results || [])
          .map(item => {
            const titulo =
              item.title || "";

            const descricao =
              item.snippet || "";

            const texto =
              `${titulo} ${descricao}`;

            // =====================================
            // PROCURA PREÇOS
            // =====================================

            const precos =
              texto.match(
                /R\$\s?[\d.]+(?:,\d{2})?/g
              ) || [];

            // Evita condomínio, IPTU etc.
            const precosValidos =
              precos.filter(p => {
                const valor =
                  Number(
                    p
                      .replace(
                        /R\$\s?/i,
                        ""
                      )
                      .replace(/\./g, "")
                      .replace(",", ".")
                      .trim()
                  );

                return valor >= 50000;
              });

            const preco =
              item.price ||
              precosValidos[0] ||
              "";

            // =====================================
            // PROCURA ÁREA
            // =====================================

            const areas =
              texto.match(
                /\d+(?:[.,]\d+)?\s?m²/gi
              ) || [];

            const area =
              areas[0] || "";

            const areaResultado =
              area
                ? Number(
                    area
                      .replace(/m²/i, "")
                      .trim()
                      .replace(",", ".")
                  )
                : null;

            // =====================================
            // CONVERTE PREÇO PARA NÚMERO
            // =====================================

            const precoValor =
              preco
                ? Number(
                    String(preco)
                      .replace(
                        /R\$\s?/i,
                        ""
                      )
                      .replace(/\./g, "")
                      .replace(",", ".")
                      .replace(
                        /[^0-9.]/g,
                        ""
                      )
                  ) || null
                : null;

            // =====================================
            // CONFERE TIPO
            // =====================================

            let tipoOk = true;

            if (
              tipoBusca ===
              "apartamento"
            ) {
              tipoOk =
                /apartamento|apto|flat|studio/i
                  .test(texto) &&
                !/\bcasa\b/i.test(texto);
            }

            if (
              tipoBusca === "casa"
            ) {
              tipoOk =
                /\bcasa\b|sobrado/i
                  .test(texto) &&
                !/apartamento|apto/i
                  .test(texto);
            }

            // =====================================
            // CONFERE QUARTOS
            // =====================================

            let quartosOk = true;

            if (quartosBusca) {
              const regexQuartos =
                new RegExp(
                  "\\b" +
                    quartosBusca +
                    "\\s*(?:quartos?|dormitórios?)",
                  "i"
                );

              quartosOk =
                regexQuartos.test(
                  texto
                );
            }

            // =====================================
            // CONFERE ÁREA
            // =====================================

            let areaOk = true;

            if (
              areaBusca &&
              areaResultado
            ) {
              const diferenca =
                Math.abs(
                  areaResultado -
                    areaBusca
                ) / areaBusca;

              // Até 35% de diferença
              areaOk =
                diferenca <= 0.35;
            }

            // =====================================
            // EXCLUI REDES SOCIAIS
            // =====================================

            const social =
              /instagram\.com|facebook\.com|youtube\.com|tiktok\.com/i
                .test(
                  item.link || ""
                );

            // =====================================
            // EXCLUI PÁGINAS COLETIVAS
            // =====================================

            const paginaColetiva =
              /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i
                .test(texto) ||
              /imóveis\s+(?:para|à)\s+venda/i
                .test(titulo) ||
              /apartamentos?\s+com\s+\d+\s+quartos?\s+(?:para|à)\s+venda/i
                .test(titulo);

            // =====================================
            // VALIDAÇÃO FINAL
            // =====================================

            const temPreco =
              Boolean(precoValor);

            const temArea =
              Boolean(
                areaResultado
              );

            const temLink =
              Boolean(
                item.link
              );

            const comparavelValido =
              temLink &&
              temPreco &&
              temArea &&
              tipoOk &&
              quartosOk &&
              areaOk &&
              !social &&
              !paginaColetiva;

            // =====================================
            // R$/M²
            // =====================================

            const precoM2 =
              precoValor &&
              areaResultado
                ? Math.round(
                    precoValor /
                      areaResultado
                  )
                : null;

            console.log(
              "DIAGNOSTICO AYRO",
              {
                titulo,
                precoValor,
                areaResultado,
                precoM2,
                tipoOk,
                quartosOk,
                areaOk,
                social,
                paginaColetiva,
                comparavelValido
              }
            );

            return {
              titulo,
              descricao,

              link:
                item.link || "",

              fonte:
                item.source ||
                item.displayed_link ||
                "",

              preco,

              preco_valor:
                precoValor,

              area,

              area_valor:
                areaResultado,

              preco_m2:
                precoM2,

              comparavel_valido:
                comparavelValido
            };
          })

          // Só mantém resultados
          // que possuem link
          .filter(
            item =>
              item.link
          );

      // =========================================
      // REMOVE LINKS DUPLICADOS
      // =========================================

      const linksVistos =
        new Set();

      const resultadosUnicos =
        resultados.filter(item => {
          const linkLimpo =
            item.link
              .split("?")[0]
              .replace(/\/$/, "");

          if (
            linksVistos.has(
              linkLimpo
            )
          ) {
            return false;
          }

          linksVistos.add(
            linkLimpo
          );

          return true;
        });

      // =========================================
      // COMPARÁVEIS VÁLIDOS
      // =========================================

      const comparaveis =
        resultadosUnicos.filter(
          item =>
            item.comparavel_valido
        );

      // =========================================
      // REFERÊNCIAS DESCARTADAS
      // =========================================

      const referencias =
        resultadosUnicos.filter(
          item =>
            !item.comparavel_valido
        );

      // =========================================
      // RESPOSTA
      // =========================================

      return res.json({
        sucesso: true,

        versao:
          "PRECISAO-V3",

        minimo_comparaveis:
          3,

        total:
          resultadosUnicos.length,

        total_comparaveis:
          comparaveis.length,

        comparaveis,

        referencias,

        // Compatibilidade com
        // o index atual
        resultados:
          resultadosUnicos
      });

    } catch (erro) {
      console.error(
        "ERRO AYRO:",
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            "Erro interno na pesquisa."
        });
    }
  }
);

// =============================================
// INICIA SERVIDOR
// =============================================

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `AYRO ACM API PRECISAO-V3 rodando na porta ${PORT}`
  );
});
