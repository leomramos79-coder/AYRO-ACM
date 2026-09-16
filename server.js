const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "AYRO ACM API online" });
});

app.get(["/api/pesquisar", "/api/search", "/search"], async (req, res) => {
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

    // Faz consultas complementares para aumentar a chance
    // de encontrar anúncios individuais.
    const consultas = [
      q,
      q + ' imóvel à venda anúncio preço R$ m²',
      q + ' apartamento venda',
      q + ' site:zapimoveis.com.br OR site:vivareal.com.br OR site:imovelweb.com.br OR site:casamineira.com.br'
    ];

    const respostas = [];

    for (const consulta of consultas) {
      const buscaOtimizada =
        consulta +
        ' -youtube -instagram -facebook -tiktok';

      const url =
        "https://serpapi.com/search.json?engine=google" +
        "&q=" + encodeURIComponent(buscaOtimizada) +
        "&location=Brazil" +
        "&hl=pt-br" +
        "&gl=br" +
        "&num=20" +
        "&api_key=" + encodeURIComponent(apiKey);

      const resposta = await fetch(url);
      const dados = await resposta.json();

      if (resposta.ok && !dados.error) {
        respostas.push(...(dados.organic_results || []));
      }
    }

    // Identifica tipo do imóvel
    const tipoBusca =
      /apartamento|apto/i.test(q)
        ? "apartamento"
        : /\bcasa\b/i.test(q)
        ? "casa"
        : "";

    // Identifica quartos
    const quartosMatch =
      q.match(/(\d+)\s*(?:quartos?|dormitórios?)/i);

    const quartosBusca =
      quartosMatch
        ? Number(quartosMatch[1])
        : null;

    // Identifica área pesquisada
    const areaMatch =
      q.match(/(\d+(?:[.,]\d+)?)\s*m(?:²|2)/i);

    const areaBusca =
      areaMatch
        ? Number(areaMatch[1].replace(",", "."))
        : null;

    const resultados = respostas
      .map(item => {

        const titulo = item.title || "";
        const descricao = item.snippet || "";

        const texto = `${titulo} ${descricao}`;

        // PREÇOS
        const precos =
          texto.match(/R\$\s?[\d.]+(?:,\d{2})?/g) || [];

        const precosValidos =
          precos.filter(p => {

            const valor =
              Number(
                p
                  .replace(/R\$\s?/i, "")
                  .replace(/\./g, "")
                  .replace(",", ".")
                  .trim()
              );

            // evita condomínio/IPTU
            return valor >= 50000;
          });

        const preco =
          item.price ||
          precosValidos[0] ||
          "";

        // ÁREA
        const areas =
          texto.match(/\d+(?:[.,]\d+)?\s?m²/gi) || [];

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

        // TIPO
        let tipoOk = true;

        if (tipoBusca === "apartamento") {
          tipoOk =
            /apartamento|apto|flat|studio/i.test(texto) &&
            !/\bcasa\b/i.test(texto);
        }

        if (tipoBusca === "casa") {
          tipoOk =
            /\bcasa\b|sobrado/i.test(texto) &&
            !/apartamento|apto/i.test(texto);
        }

        // QUARTOS
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

          // Alguns portais escrevem "2 quartos2 ban"
          if (!quartosOk) {
            quartosOk =
              new RegExp(
                "\\b" +
                quartosBusca +
                "\\s*(?:quartos?|dorm)",
                "i"
              ).test(texto);
          }
        }

        // ÁREA
        let areaOk = true;

        if (areaBusca && areaResultado) {

          const diferenca =
            Math.abs(
              areaResultado - areaBusca
            ) / areaBusca;

          // tolerância de 35%
          areaOk =
            diferenca <= 0.35;
        }

        // REDES SOCIAIS
        const social =
          /instagram\.com|facebook\.com|youtube\.com|tiktok\.com/i
            .test(item.link || "");

        const temPreco =
          Boolean(preco);

        const temArea =
          Boolean(areaResultado);

        // PÁGINAS COLETIVAS
        const paginaColetiva =
          /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i
            .test(texto) ||

          /imóveis\s+(?:para|à)\s+venda/i
            .test(titulo) ||

          /\b(?:lista|listagem|busca|pesquisa)\b/i
            .test(titulo);

        const comparavelValido =
          Boolean(item.link) &&
          temPreco &&
          temArea &&
          tipoOk &&
          quartosOk &&
          areaOk &&
          !social &&
          !paginaColetiva;

        return {
          titulo: titulo,
          descricao: descricao,
          link: item.link || "",

          fonte:
            item.source ||
            item.displayed_link ||
            "",

          preco: preco,
          area: area,

          preco_valor:
            preco
              ? Number(
                  preco
                    .replace(/R\$\s?/i, "")
                    .replace(/\./g, "")
                    .replace(",", ".")
                    .trim()
                )
              : null,

          area_valor:
            areaResultado,

          comparavel_valido:
            comparavelValido
        };
      })
      .filter(item => item.link);

    // =====================================================
    // REMOVE LINKS EXATAMENTE DUPLICADOS
    // =====================================================

    const linksVistos = new Set();

    const resultadosUnicos =
      resultados.filter(item => {

        const linkLimpo =
          item.link
            .split("?")[0]
            .replace(/\/$/, "");

        if (linksVistos.has(linkLimpo)) {
          return false;
        }

        linksVistos.add(linkLimpo);

        return true;
      });

    // =====================================================
    // REMOVE O MESMO IMÓVEL REPETIDO
    // MESMA FONTE + PREÇO + ÁREA
    // =====================================================

    const imoveisVistos =
      new Set();

    const resultadosSemDuplicados =
      resultadosUnicos.filter(item => {

        // Referências sem preço/área continuam aparecendo
        if (
          !item.preco_valor ||
          !item.area_valor
        ) {
          return true;
        }

        const fonte =
          String(item.fonte || "")
            .toLowerCase()
            .trim();

        const chave =
          fonte +
          "|" +
          item.preco_valor +
          "|" +
          item.area_valor;

        if (imoveisVistos.has(chave)) {
          return false;
        }

        imoveisVistos.add(chave);

        return true;
      });

    // COMPARÁVEIS
    const comparaveis =
      resultadosSemDuplicados.filter(
        item =>
          item.comparavel_valido
      );

    // REFERÊNCIAS
    const referencias =
      resultadosSemDuplicados.filter(
        item =>
          !item.comparavel_valido
      );

    // RESPOSTA DA API
    res.json({

      sucesso: true,

      total:
        resultadosSemDuplicados.length,

      total_comparaveis:
        comparaveis.length,

      comparaveis:
        comparaveis,

      referencias:
        referencias,

      // Mantido para o index.html
      resultados:
        resultadosSemDuplicados
    });

  } catch (erro) {

    console.error(
      "ERRO AYRO:",
      erro
    );

    res.status(500).json({
      erro:
        "Erro interno na pesquisa."
    });
  }
});

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `AYRO ACM API rodando na porta ${PORT}`
  );

});
