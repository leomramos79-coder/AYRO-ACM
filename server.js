const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "AYRO ACM API online" });
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

      // ==========================================
      // IDENTIFICA O IMÓVEL QUE ESTAMOS PROCURANDO
      // ==========================================

      const tipoBusca =
        /apartamento|apto/i.test(q)
          ? "apartamento"
          : /\bcasa\b/i.test(q)
          ? "casa"
          : "";

      const quartosMatch =
        q.match(/(\d+)\s*(?:quartos?|dormitórios?)/i);

      const quartosBusca =
        quartosMatch
          ? Number(quartosMatch[1])
          : null;

      const areaMatch =
        q.match(/(\d+(?:[.,]\d+)?)\s*m(?:²|2)/i);

      const areaBusca =
        areaMatch
          ? Number(areaMatch[1].replace(",", "."))
          : null;

      // ==========================================
      // FAZ BUSCAS COMPLEMENTARES
      // ==========================================
      // Não dependemos mais de uma única pesquisa.
      // Isso aumenta a chance de encontrar anúncios
      // individuais com preço e metragem.

      const consultas = [
        q,

        q +
          ' imóvel à venda anúncio "R$" "m²"' +
          ' -youtube -instagram -facebook -tiktok',

        q +
          ' apartamento casa venda "R$" "m²"' +
          ' -youtube -instagram -facebook -tiktok'
      ];

      const lotesResultados =
        await Promise.all(
          consultas.map(async consulta => {

            const url =
              "https://serpapi.com/search.json?engine=google" +
              "&q=" +
              encodeURIComponent(consulta) +
              "&location=Brazil" +
              "&hl=pt-br" +
              "&gl=br" +
              "&num=20" +
              "&api_key=" +
              encodeURIComponent(apiKey);

            const resposta =
              await fetch(url);

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
          })
        );

      // Junta os resultados das pesquisas
      const resultadosGoogle =
        lotesResultados.flat();

      // ==========================================
      // ANALISA CADA RESULTADO
      // ==========================================

      const resultados =
        resultadosGoogle
          .map(item => {

            const titulo =
              item.title || "";

            const descricao =
              item.snippet || "";

            const link =
              item.link || "";

            const texto =
              `${titulo} ${descricao}`;

            // --------------------------
            // PREÇO
            // --------------------------

            const precos =
              texto.match(
                /R\$\s?[\d.]+(?:,\d{2})?/g
              ) || [];

            const precosValidos =
              precos.filter(p => {

                const valor =
                  Number(
                    p
                      .replace(
                        /R\$\s?/i,
                        ""
                      )
                      .replace(
                        /\./g,
                        ""
                      )
                      .replace(
                        ",",
                        "."
                      )
                      .trim()
                  );

                // Evita confundir
                // condomínio/IPTU com
                // preço do imóvel
                return (
                  Number.isFinite(valor) &&
                  valor >= 50000
                );
              });

            const preco =
              item.price ||
              precosValidos[0] ||
              "";

            // --------------------------
            // ÁREA
            // --------------------------

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
                      .replace(
                        /m²/i,
                        ""
                      )
                      .trim()
                      .replace(
                        ",",
                        "."
                      )
                  )
                : null;

            // --------------------------
            // TIPO DO IMÓVEL
            // --------------------------

            let tipoOk = true;

            if (
              tipoBusca ===
              "apartamento"
            ) {
              tipoOk =
                /apartamento|apto|flat|studio/i
                  .test(texto) &&
                !/\bcasa\b/i
                  .test(texto);
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

            // --------------------------
            // QUARTOS
            // --------------------------

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

            // --------------------------
            // ÁREA COMPATÍVEL
            // --------------------------

            let areaOk = true;

            if (
              areaBusca &&
              areaResultado
            ) {

              const diferenca =
                Math.abs(
                  areaResultado -
                    areaBusca
                ) /
                areaBusca;

              // Até 35% de diferença
              areaOk =
                diferenca <= 0.35;
            }

            // Se pesquisamos uma área
            // e o anúncio não informa área,
            // ele não entra no ACM.
            if (
              areaBusca &&
              !areaResultado
            ) {
              areaOk = false;
            }

            // --------------------------
            // REDES SOCIAIS
            // --------------------------

            const social =
              /instagram\.com|facebook\.com|youtube\.com|tiktok\.com/i
                .test(link);

            // --------------------------
            // PÁGINAS COLETIVAS
            // --------------------------

            const paginaColetiva =
              /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i
                .test(texto) ||

              /imóveis\s+(?:para|à)\s+venda/i
                .test(titulo) ||

              /apartamentos?\s+com\s+\d+\s+quartos?\s+(?:para|à)\s+venda/i
                .test(titulo) ||

              /lista\s+de\s+imóveis/i
                .test(titulo);

            const temPreco =
              Boolean(preco);

            const temArea =
              Boolean(areaResultado);

            // ======================================
            // REGRA FINAL DO COMPARÁVEL
            // ======================================

            const comparavelValido =
              Boolean(link) &&
              temPreco &&
              temArea &&
              tipoOk &&
              quartosOk &&
              areaOk &&
              !social &&
              !paginaColetiva;

            return {
              titulo,
              descricao,
              link,

              fonte:
                item.source ||
                item.displayed_link ||
                "",

              preco,
              area,

              comparavel_valido:
                comparavelValido
            };
          })
          .filter(
            item => item.link
          );

      // ==========================================
      // REMOVE RESULTADOS DUPLICADOS
      // ==========================================

      const linksVistos =
        new Set();

      const resultadosUnicos =
        resultados.filter(item => {

          const linkLimpo =
            item.link
              .split("?")[0]
              .replace(
                /\/$/,
                ""
              );

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

      // ==========================================
      // SEPARA COMPARÁVEIS DE REFERÊNCIAS
      // ==========================================

      const comparaveis =
        resultadosUnicos.filter(
          item =>
            item.comparavel_valido
        );

      const referencias =
        resultadosUnicos.filter(
          item =>
            !item.comparavel_valido
        );

      // ==========================================
      // RETORNO PARA O AYRO
      // ==========================================

      res.json({
        sucesso: true,

        total:
          resultadosUnicos.length,

        total_comparaveis:
          comparaveis.length,

        comparaveis,

        referencias,

        // Mantido para não quebrar
        // o index.html atual
        resultados:
          resultadosUnicos
      });

    } catch (erro) {

      console.error(
        "ERRO AYRO:",
        erro
      );

      res.status(500).json({
        erro:
          erro.message ||
          "Erro interno na pesquisa."
      });
    }
  }
);

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {
    console.log(
      `AYRO ACM API rodando na porta ${PORT}`
    );
  }
);
