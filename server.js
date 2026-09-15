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
      return res.status(400).json({ erro: "Informe uma pesquisa." });
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

    res.json(dados);

  } catch (erro) {
    console.error(erro);

    res.status(500).json({
      erro: "Erro interno na pesquisa."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`AYRO ACM API rodando na porta ${PORT}`);
});
