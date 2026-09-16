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

      // ==================================================
      // IDENTIFICA AS CARACTERÍSTICAS DO IMÓVEL PESQUISADO
      // ==================================================

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

      // ==================================================
      // MONTA BUSCAS DIRECIONADAS PARA ANÚNCIOS INDIVIDUAIS
      // ==================================================
      //
      // A pesquisa genérica continua existindo como apoio.
      // As demais procuram páginas individuais dos portais.
      //
      // IMPORTANTE:
      // Uma pesquisa que falhar NÃO derruba as demais.

      const consultas = [
        q + ' "R$" "m²" -instagram -facebook -youtube -tiktok',

        'site:chavesnamao.com.br/imovel/ ' +
          q +
          ' "R$" "m²"',

        'site:imovelweb.com.br/propriedades/ ' +
          q +
          ' "R$" "m²"'
      ];

      async function pesquisarGoogle(consulta) {
        try {
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

          const resposta = await fetch(url);

          const dados = await resposta.json();

          if (!resposta.ok || dados.error) {
            console.warn(
              "Consulta ignorada:",
              consulta,
              dados.error || "Erro SerpAPI"
            );

            return [];
          }

          return dados.organic_results || [];
        } catch (erroConsulta) {
          console.warn(
            "Falha em uma consulta:",
            consulta,
            erroConsulta.message
          );

          return [];
        }
      }

      // Executa as pesquisas sem permitir que uma falha
      // interrompa toda a avaliação.

      const lotesResultados =
        await Promise.all(
          consultas.map(pesquisarGoogle)
        );

      const resultadosGoogle =
        lotesResultados.flat();

      // Se nenhuma das pesquisas conseguiu retornar algo,
      // respondemos normalmente, sem gerar erro 500.

      if (!resultadosGoogle.length) {
        return res.json({
          sucesso: true,
          total: 0,
          total_comparaveis: 0,
          comparaveis: [],
          referencias: [],
          resultados: [],
          aviso:
            "Nenhum anúncio foi encontrado para esta pesquisa."
        });
      }

      // ==================================================
      // FUNÇÕES AUXILIARES
      // ==================================================

      function extrairPreco(texto, item) {
        if (item.price) {
          const precoItem = String(item.price);

          if (/R\$/i.test(precoItem)) {
            return precoItem;
          }
        }

        const encontrados =
          texto.match(
            /R\$\s?[\d.]+(?:,\d{2})?/g
          ) || [];

        for (const precoTexto of encontrados) {
          const valor =
            Number(
              precoTexto
                .replace(/R\$\s?/i, "")
                .replace(/\./g, "")
                .replace(",", ".")
                .trim()
            );

          // Evita usar condomínio/IPTU como valor do imóvel.
          if (
            Number.isFinite(valor) &&
            valor >= 50000
          ) {
            return precoTexto;
          }
        }

        return "";
      }

      function extrairArea(texto) {
        const encontrados =
          texto.match(
            /\d+(?:[.,]\d+)?\s?m(?:²|2)\b/gi
          ) || [];

        if (!encontrados.length) {
          return {
            areaTexto: "",
            areaNumero: null
          };
        }

        // Quando temos área-alvo, escolhemos a área
        // encontrada mais próxima da pesquisada.
        let melhorArea = null;
        let melhorTexto = "";

        for (const areaTexto of encontrados) {
          const numero =
            Number(
              areaTexto
                .replace(/m(?:²|2)/i, "")
                .trim()
                .replace(",", ".")
            );

          if (
            !Number.isFinite(numero) ||
            numero <= 0
          ) {
            continue;
          }

          if (!areaBusca) {
            return {
              areaTexto,
              areaNumero: numero
            };
          }

          const distancia =
            Math.abs(numero - areaBusca);

          if (
            melhorArea === null ||
            distancia <
              Math.abs(melhorArea - areaBusca)
          ) {
            melhorArea = numero;
            melhorTexto = areaTexto;
          }
        }

        return {
          areaTexto: melhorTexto,
          areaNumero: melhorArea
        };
      }

      function dominioDoLink(link) {
        try {
          return new URL(link).hostname
            .replace(/^www\./, "");
        } catch {
          return "";
        }
      }

      function ehPaginaIndividual(link) {
        const url = link.toLowerCase();

        // Chaves na Mão: anúncios individuais usam /imovel/
        if (
          /chavesnamao\.com\.br/.test(url)
        ) {
          return /\/imovel\//.test(url);
        }

        // Imovelweb: anúncios individuais usam /propriedades/
        if (
          /imovelweb\.com\.br/.test(url)
        ) {
          return /\/propriedades\//.test(url);
        }

        // Para outros sites não aprovamos automaticamente
        // como individual. Eles ficam como referência.
        return false;
      }

      function normalizarLink(link) {
        try {
          const url = new URL(link);

          url.hash = "";

          // Remove parâmetros de rastreamento.
          [
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "utm_term",
            "utm_content",
            "gclid",
            "fbclid",
            "relatedAds"
          ].forEach(param => {
            url.searchParams.delete(param);
          });

          return url.toString()
            .replace(/\/$/, "");
        } catch {
          return link
            .split("?")[0]
            .replace(/\/$/, "");
        }
      }

      // ==================================================
      // ANALISA OS RESULTADOS
      // ==================================================

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

            const preco =
              extrairPreco(texto, item);

            const {
              areaTexto: area,
              areaNumero: areaResultado
            } =
              extrairArea(texto);

            // ----------------------------------------------
            // TIPO DO IMÓVEL
            // ----------------------------------------------

            let tipoOk = true;

            if (
              tipoBusca === "apartamento"
            ) {
              tipoOk =
                /apartamento|apto|flat|studio/i
                  .test(texto) &&
                !/\bcasa\b/i.test(texto);
            }

            if (tipoBusca === "casa") {
              tipoOk =
                /\bcasa\b|sobrado/i
                  .test(texto) &&
                !/apartamento|apto/i
                  .test(texto);
            }

            // ----------------------------------------------
            // QUARTOS
            // ----------------------------------------------

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
                regexQuartos.test(texto);
            }

            // ----------------------------------------------
            // ÁREA COMPATÍVEL
            // ----------------------------------------------

            let areaOk = true;

            if (areaBusca) {
              if (!areaResultado) {
                areaOk = false;
              } else {
                const diferenca =
                  Math.abs(
                    areaResultado -
                      areaBusca
                  ) / areaBusca;

                // Mantemos tolerância de 35%.
                areaOk =
                  diferenca <= 0.35;
              }
            }

            // ----------------------------------------------
            // BLOQUEIOS
            // ----------------------------------------------

            const social =
              /instagram\.com|facebook\.com|youtube\.com|tiktok\.com/i
                .test(link);

            const paginaColetivaTexto =
              /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i
                .test(titulo) ||
              /imóveis\s+(?:para|à)\s+venda/i
                .test(titulo) ||
              /apartamentos?\s+com\s+\d+\s+quartos?\s+(?:para|à)\s+venda/i
                .test(titulo) ||
              /lista\s+de\s+imóveis/i
                .test(titulo);

            const paginaIndividual =
              ehPaginaIndividual(link);

            const temPreco =
              Boolean(preco);

            const temArea =
              Number.isFinite(areaResultado);

            // ==============================================
            // REGRA FINAL DO COMPARÁVEL
            // ==============================================
            //
            // Só entra no ACM quando:
            // - é página individual confirmada;
            // - possui preço;
            // - possui metragem;
            // - tipo é compatível;
            // - quartos são compatíveis;
            // - área está dentro da tolerância;
            // - não é rede social;
            // - não aparenta ser listagem coletiva.

            const comparavelValido =
              Boolean(link) &&
              paginaIndividual &&
              temPreco &&
              temArea &&
              tipoOk &&
              quartosOk &&
              areaOk &&
              !social &&
              !paginaColetivaTexto;

            return {
              titulo,
              descricao,
              link: normalizarLink(link),

              fonte:
                item.source ||
                item.displayed_link ||
                dominioDoLink(link),

              preco,
              area,

              comparavel_valido:
                comparavelValido
            };
          })
          .filter(item =>
            Boolean(item.link)
          );

      // ==================================================
      // REMOVE DUPLICADOS
      // ==================================================

      const linksVistos =
        new Set();

      const resultadosUnicos =
        resultados.filter(item => {
          const linkLimpo =
            item.link
              .split("?")[0]
              .replace(/\/$/, "");

          if (
            linksVistos.has(linkLimpo)
          ) {
            return false;
          }

          linksVistos.add(linkLimpo);

          return true;
        });

      // ==================================================
      // SEPARA COMPARÁVEIS E REFERÊNCIAS
      // ==================================================

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

      // ==================================================
      // RETORNO PARA O AYRO
      // ==================================================

      res.json({
        sucesso: true,

        total:
          resultadosUnicos.length,

        total_comparaveis:
          comparaveis.length,

        comparaveis,

        referencias,

        // Mantido para compatibilidade com o index.html.
        resultados:
          resultadosUnicos,

        aviso:
          comparaveis.length === 0
            ? "Foram encontradas referências, mas nenhum anúncio individual passou por todos os critérios do ACM."
            : ""
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
