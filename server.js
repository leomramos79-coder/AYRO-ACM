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

    const url =
      "https://serpapi.com/search.json?engine=google" +
      "&q=" + encodeURIComponent(q) +
      "&location=Brazil" +
      "&hl=pt-br" +
      "&gl=br" +
      "&api_key=" + encodeURIComponent(apiKey);

    const resposta = await fetch(url);
    const dados = await resposta.json();

    if (!resposta.ok || dados.error) {
      return res.status(500).json({
        erro: dados.error || "Erro ao consultar a SerpApi."
      });
    }

    // Identifica o imóvel pesquisado
    const tipoBusca =
      /apartamento|apto/i.test(q)
        ? "apartamento"
        : /\bcasa\b/i.test(q)
        ? "casa"
        : "";

    const quartosMatch = q.match(/(\d+)\s*quartos?/i);
    const quartosBusca = quartosMatch
      ? Number(quartosMatch[1])
      : null;

    const areaMatch = q.match(
      /(\d+(?:[.,]\d+)?)\s*m(?:²|2)/i
    );

    const areaBusca = areaMatch
      ? Number(areaMatch[1].replace(",", "."))
      : null;

    const resultados = (dados.organic_results || [])
      .map(item => {

        const titulo = item.title || "";
        const descricao = item.snippet || "";

        const texto = `${titulo} ${descricao}`;

        const precos =
          texto.match(/R\$\s?[\d.]+(?:,\d{2})?/g) || [];

        const areas =
          texto.match(/\d+(?:[.,]\d+)?\s?m²/gi) || [];

        // Identifica o preço de venda e evita confundir com condomínio/IPTU
const precosValidos = precos.filter(p => {
  const valor = Number(
    p.replace(/R\$\s?/i, "")
     .replace(/\./g, "")
     .replace(",", ".")
     .trim()
  );

  return valor >= 50000;
});

const preco = item.price || precosValidos[0] || "";
        const area = areas[0] || "";

        const areaResultado = area
          ? Number(
              area
                .replace(/m²/i, "")
                .trim()
                .replace(",", ".")
            )
          : null;

        // Confere o tipo do imóvel
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

        // Confere quartos
        let quartosOk = true;

        if (quartosBusca) {
          const regexQuartos = new RegExp(
            "\\b" +
            quartosBusca +
            "\\s*(?:quartos?|dormitórios?)",
            "i"
          );

          quartosOk = regexQuartos.test(texto);
        }

        // Confere área
        let areaOk = true;

        if (areaBusca && areaResultado) {
          const diferenca =
            Math.abs(areaResultado - areaBusca) /
            areaBusca;

          // tolerância máxima de 35%
          areaOk = diferenca <= 0.35;
        }

        // Exclui redes sociais
        const social =
          /instagram\.com|facebook\.com|youtube\.com|tiktok\.com/i
          .test(item.link || "");

       // Só aceita como comparável anúncio individual com dados suficientes
const temPreco = Boolean(preco);
const temArea = Boolean(areaResultado);

const paginaColetiva =
  /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i.test(texto) ||
  /imóveis\s+(?:para|à)\s+venda/i.test(titulo) ||
  /apartamentos?\s+com\s+\d+\s+quartos?\s+(?:para|à)\s+venda/i.test(titulo);

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
          comparavel_valido: comparavelValido
        };
      })
      .filter(item => item.link);

    // Remove links duplicados
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

    const comparaveis =
      resultadosUnicos.filter(
        item => item.comparavel_valido
      );

    const referencias =
      resultadosUnicos.filter(
        item => !item.comparavel_valido
      );

    res.json({
      sucesso: true,

      total: resultadosUnicos.length,

      total_comparaveis:
        comparaveis.length,

      comparaveis: comparaveis,

      referencias: referencias,

      // Mantido para o index.html atual continuar funcionando
      resultados: resultadosUnicos
    });

  } catch (erro) {

    console.error(erro);

    res.status(500).json({
      erro: "Erro interno na pesquisa."
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
