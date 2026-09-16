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

    const buscaOtimizada =
      q +
      ' imóvel à venda anúncio' +
      ' preço R$' +
      ' m²' +
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

    if (!resposta.ok || dados.error) {
      return res.status(500).json({
        erro: dados.error || "Erro ao consultar a SerpApi."
      });
    }

    // Identifica o tipo do imóvel
    const tipoBusca =
      /apartamento|apto/i.test(q)
        ? "apartamento"
        : /\bcasa\b/i.test(q)
        ? "casa"
        : "";

    // Identifica quantidade de quartos
    const quartosMatch =
      q.match(/(\d+)\s*quartos?/i);

    const quartosBusca =
      quartosMatch
        ? Number(quartosMatch[1])
        : null;

    // Identifica área
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

    const resultados =
      (dados.organic_results || [])
        .map(item => {

          const titulo =
            item.title || "";

          const descricao =
            item.snippet || "";

          const texto =
            `${titulo} ${descricao}`;

          // Procura preços
          const precos =
            texto.match(
              /R\$\s?[\d.]+(?:,\d{2})?/g
            ) || [];

          // Procura áreas
          const areas =
            texto.match(
              /\d+(?:[.,]\d+)?\s?m²/gi
            ) || [];

          // Evita confundir condomínio e IPTU
          // com preço de venda
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

              return valor >= 50000;
            });

          const preco =
            item.price ||
            precosValidos[0] ||
            "";

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

          // Confere tipo do imóvel
          let tipoOk = true;

          if (tipoBusca === "apartamento") {
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

          // Confere quartos
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

          // Confere área
          let areaOk = true;

          if (
            areaBusca &&
            areaResultado
          ) {

            const diferenca =
              Math.abs(
                areaResultado - areaBusca
              ) / areaBusca;

            // tolerância máxima de 35%
            areaOk =
              diferenca <= 0.35;
          }

          // Exclui redes sociais
          const social =
            /instagram\.com|facebook\.com|youtube\.com|tiktok\.com/i
              .test(item.link || "");

          const temPreco =
            Boolean(preco);

          const temArea =
            Boolean(areaResultado);

          // Detecta páginas coletivas
          const paginaColetiva =
            /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i
              .test(texto) ||

            /imóveis\s+(?:para|à)\s+venda/i
              .test(titulo) ||

            /apartamentos?\s+com\s+\d+\s+quartos?\s+(?:para|à)\s+venda/i
              .test(titulo);

          // Mantém exatamente a lógica
          // da versão que encontrou comparáveis
          const comparavelValido =
            Boolean(item.link) &&
            temPreco &&
            tipoOk &&
            quartosOk &&
            areaOk &&
            !social &&
            !paginaColetiva;

          console.log(
            "DIAGNOSTICO AYRO",
            {
              titulo,
              temPreco,
              temArea,
              tipoOk,
              quartosOk,
              areaOk,
              social,
              paginaColetiva,
              comparavelValido
            }
          );

          return {
            titulo: titulo,

            descricao:
              descricao,

            link:
              item.link || "",

            fonte:
              item.source ||
              item.displayed_link ||
              "",

            preco:
              preco,

            area:
              area,

            comparavel_valido:
              comparavelValido
          };
        })
        .filter(
          item => item.link
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
          linksVistos.has(linkLimpo)
        ) {
          return false;
        }

        linksVistos.add(linkLimpo);

        return true;
      });

    // =========================================
    // COMPARÁVEIS
    // REMOVE APENAS DUPLICIDADE APARENTE
    // NÃO ALTERA O FILTRO ORIGINAL
    // =========================================

    const chavesComparaveis =
      new Set();

    const comparaveis =
      resultadosUnicos.filter(item => {

        if (
          !item.comparavel_valido
        ) {
          return false;
        }

        const fonte =
          String(item.fonte || "")
            .toLowerCase()
            .trim();

        const precoChave =
          String(item.preco || "")
            .replace(/\s+/g, "")
            .toLowerCase();

        const areaChave =
          String(item.area || "")
            .replace(/\s+/g, "")
            .toLowerCase();

        // Só remove duplicidade quando
        // preço E área estão identificados
        if (
          precoChave &&
          areaChave
        ) {

          const chave =
            `${fonte}|${precoChave}|${areaChave}`;

          if (
            chavesComparaveis.has(chave)
          ) {
            return false;
          }

          chavesComparaveis.add(chave);
        }

        return true;
      });

    // =========================================
    // REFERÊNCIAS
    // =========================================

    const referencias =
      resultadosUnicos.filter(
        item =>
          !item.comparavel_valido
      );

    // =========================================
    // RESPOSTA PARA O APLICATIVO
    // =========================================

    res.json({
      sucesso: true,

      total:
        resultadosUnicos.length,

      total_comparaveis:
        comparaveis.length,

      comparaveis:
        comparaveis,

      referencias:
        referencias,

      // Mantido para o index.html atual
      resultados:
        resultadosUnicos
    });

  } catch (erro) {

    console.error(erro);

    res.status(500).json({
      erro:
        "Erro interno na pesquisa."
    });
  }
});


// =====================================================
// MERCADO PAGO - ASSINATURA AYRO ACM PRO
// R$ 49,90 POR MÊS
// =====================================================

app.post("/api/mercadopago/criar-assinatura", async (req, res) => {

  try {

    const accessToken =
      process.env.MERCADOPAGO_ACCESS_TOKEN;

    if (!accessToken) {

      return res.status(500).json({
        erro:
          "MERCADOPAGO_ACCESS_TOKEN não configurado no servidor."
      });

    }

    const { email } =
      req.body || {};

    if (!email) {

      return res.status(400).json({
        erro:
          "Informe o e-mail do cliente."
      });

    }

    const assinatura = {

      reason:
        "AYRO ACM Pro",

      external_reference:
        `AYRO-${Date.now()}`,

      payer_email:
        email,

      auto_recurring: {

        frequency:
          1,

        frequency_type:
          "months",

        transaction_amount:
          49.90,

        currency_id:
          "BRL"

      },

      back_url:
        "https://ayro-acm.onrender.com",

      status:
        "pending"

    };


    const resposta =
      await fetch(
        "https://api.mercadopago.com/preapproval",
        {

          method:
            "POST",

          headers: {

            "Authorization":
              `Bearer ${accessToken}`,

            "Content-Type":
              "application/json"

          },

          body:
            JSON.stringify(assinatura)

        }
      );


    const dados =
      await resposta.json();


    if (!resposta.ok) {

      console.error(
        "Erro Mercado Pago:",
        dados
      );

      return res
        .status(resposta.status)
        .json({

          erro:
            "Não foi possível criar a assinatura.",

          detalhes:
            dados

        });

    }


    return res.json({

      sucesso:
        true,

      assinatura_id:
        dados.id,

      status:
        dados.status,

      checkout_url:
        dados.init_point

    });


  } catch (erro) {

    console.error(
      "Erro ao criar assinatura Mercado Pago:",
      erro
    );

    return res.status(500).json({

      erro:
        "Erro interno ao criar assinatura."

    });

  }

});


// =====================================================
// SERVIDOR
// =====================================================

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `AYRO ACM API rodando na porta ${PORT}`
  );

});
