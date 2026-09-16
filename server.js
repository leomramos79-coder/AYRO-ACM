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

    const tipoBusca =
      /apartamento|apto/i.test(q)
        ? "apartamento"
        : /\bcasa\b/i.test(q)
        ? "casa"
        : "";

    const quartosMatch =
      q.match(/(\d+)\s*quartos?/i);

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

    const resultados =
      (dados.organic_results || [])
        .map(item => {

          const titulo =
            item.title || "";

          const descricao =
            item.snippet || "";

          const texto =
            `${titulo} ${descricao}`;

          const precos =
            texto.match(
              /R\$\s?[\d.]+(?:,\d{2})?/g
            ) || [];

          const areas =
            texto.match(
              /\d+(?:[.,]\d+)?\s?m²/gi
            ) || [];

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

          let areaOk = true;

          if (
            areaBusca &&
            areaResultado
          ) {

            const diferenca =
              Math.abs(
                areaResultado - areaBusca
              ) / areaBusca;

            areaOk =
              diferenca <= 0.35;
          }

          const social =
            /instagram\.com|facebook\.com|youtube\.com|tiktok\.com/i
              .test(item.link || "");

          const temPreco =
            Boolean(preco);

          const temArea =
            Boolean(areaResultado);

          const paginaColetiva =
            /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i
              .test(texto) ||

            /imóveis\s+(?:para|à)\s+venda/i
              .test(titulo) ||

            /apartamentos?\s+com\s+\d+\s+quartos?\s+(?:para|à)\s+venda/i
              .test(titulo);

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

    const referencias =
      resultadosUnicos.filter(
        item =>
          !item.comparavel_valido
      );

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


// =========================================
// MERCADO PAGO - PLANO AYRO ACM PRO
// R$ 49,90 por mês
// =========================================

const MP_API = "https://api.mercadopago.com";

const AYRO_BACK_URL =
  process.env.AYRO_BACK_URL ||
  "https://ayro-acm.onrender.com";


function mercadoPagoHeaders() {

  const accessToken =
    process.env.MERCADOPAGO_ACCESS_TOKEN;

  if (!accessToken) return null;

  return {
    Authorization:
      `Bearer ${accessToken}`,

    "Content-Type":
      "application/json"
  };
}


async function lerRespostaJson(resposta) {

  const texto =
    await resposta.text();

  if (!texto) return {};

  try {
    return JSON.parse(texto);
  } catch {
    return {
      message: texto
    };
  }
}


// =========================================
// CRIAR PLANO COMPARTILHÁVEL
// =========================================

app.post(
  "/api/mercadopago/criar-plano",
  async (req, res) => {

    try {

      const headers =
        mercadoPagoHeaders();

      if (!headers) {

        return res.status(500).json({
          erro:
            "MERCADOPAGO_ACCESS_TOKEN não configurado no servidor."
        });
      }


      const plano = {

        reason:
          "AYRO ACM Pro",

        external_reference:
          `AYRO-ACM-PRO-${Date.now()}`,

        auto_recurring: {

          frequency: 1,

          frequency_type:
            "months",

          transaction_amount:
            49.90,

          currency_id:
            "BRL"
        },

        back_url:
          AYRO_BACK_URL
      };


      const resposta =
        await fetch(
          `${MP_API}/preapproval_plan`,
          {
            method: "POST",
            headers,
            body:
              JSON.stringify(plano)
          }
        );


      const dados =
        await lerRespostaJson(
          resposta
        );


      if (!resposta.ok) {

        console.error(
          "Erro Mercado Pago ao criar plano:",
          dados
        );

        return res
          .status(resposta.status)
          .json({

            erro:
              "Não foi possível criar o plano de assinatura.",

            detalhes:
              dados
          });
      }


      return res.json({

        sucesso: true,

        plano_id:
          dados.id,

        status:
          dados.status,

        checkout_url:
          dados.init_point,

        init_point:
          dados.init_point,

        auto_recurring:
          dados.auto_recurring
      });


    } catch (erro) {

      console.error(
        "Erro ao criar plano Mercado Pago:",
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            "Erro interno ao criar o plano."
        });
    }
  }
);


// =========================================
// COMPATIBILIDADE COM O INDEX.HTML ATUAL
// =========================================

app.post(
  "/api/mercadopago/criar-assinatura",
  async (req, res) => {

    try {

      const headers =
        mercadoPagoHeaders();

      if (!headers) {

        return res.status(500).json({
          erro:
            "MERCADOPAGO_ACCESS_TOKEN não configurado no servidor."
        });
      }


      const planoConfigurado =
        String(
          process.env.MERCADOPAGO_PLAN_ID ||
          ""
        ).trim();


      // Se já tivermos um plano,
      // reutiliza sempre o mesmo.
      if (planoConfigurado) {

        const consulta =
          await fetch(
            `${MP_API}/preapproval_plan/${encodeURIComponent(planoConfigurado)}`,
            {
              method: "GET",
              headers
            }
          );


        const plano =
          await lerRespostaJson(
            consulta
          );


        if (!consulta.ok) {

          console.error(
            "Erro ao consultar plano configurado:",
            plano
          );

          return res
            .status(consulta.status)
            .json({

              erro:
                "O MERCADOPAGO_PLAN_ID configurado não pôde ser consultado.",

              detalhes:
                plano
            });
        }


        return res.json({

          sucesso: true,

          plano_id:
            plano.id,

          status:
            plano.status,

          checkout_url:
            plano.init_point,

          init_point:
            plano.init_point
        });
      }


      // Se ainda não existe plano configurado,
      // cria o primeiro.

      const payload = {

        reason:
          "AYRO ACM Pro",

        external_reference:
          `AYRO-ACM-PRO-${Date.now()}`,

        auto_recurring: {

          frequency: 1,

          frequency_type:
            "months",

          transaction_amount:
            49.90,

          currency_id:
            "BRL"
        },

        back_url:
          AYRO_BACK_URL
      };


      const resposta =
        await fetch(
          `${MP_API}/preapproval_plan`,
          {

            method:
              "POST",

            headers,

            body:
              JSON.stringify(payload)
          }
        );


      const dados =
        await lerRespostaJson(
          resposta
        );


      if (!resposta.ok) {

        console.error(
          "Erro Mercado Pago:",
          dados
        );

        return res
          .status(resposta.status)
          .json({

            erro:
              "Não foi possível criar o plano de assinatura.",

            detalhes:
              dados
          });
      }


      return res.json({

        sucesso:
          true,

        plano_id:
          dados.id,

        status:
          dados.status,

        checkout_url:
          dados.init_point,

        init_point:
          dados.init_point,

        aviso:
          "Salve este plano_id como MERCADOPAGO_PLAN_ID no Render para reutilizar o mesmo plano."
      });


    } catch (erro) {

      console.error(
        "Erro Mercado Pago:",
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            "Erro interno no Mercado Pago."
        });
    }
  }
);


// =========================================
// CONSULTAR PLANO
// =========================================

app.get(
  "/api/mercadopago/consultar-plano/:id",
  async (req, res) => {

    try {

      const headers =
        mercadoPagoHeaders();

      if (!headers) {

        return res.status(500).json({
          erro:
            "MERCADOPAGO_ACCESS_TOKEN não configurado no servidor."
        });
      }


      const id =
        String(
          req.params.id || ""
        ).trim();


      if (!id) {

        return res
          .status(400)
          .json({
            erro:
              "ID do plano não informado."
          });
      }


      const resposta =
        await fetch(
          `${MP_API}/preapproval_plan/${encodeURIComponent(id)}`,
          {
            method:
              "GET",

            headers
          }
        );


      const dados =
        await lerRespostaJson(
          resposta
        );


      if (!resposta.ok) {

        return res
          .status(resposta.status)
          .json({

            erro:
              "Não foi possível consultar o plano.",

            detalhes:
              dados
          });
      }


      return res.json({

        sucesso:
          true,

        id:
          dados.id,

        status:
          dados.status,

        reason:
          dados.reason,

        init_point:
          dados.init_point,

        back_url:
          dados.back_url,

        auto_recurring:
          dados.auto_recurring,

        date_created:
          dados.date_created,

        last_modified:
          dados.last_modified
      });


    } catch (erro) {

      console.error(
        "Erro ao consultar plano Mercado Pago:",
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            "Erro interno ao consultar o plano."
        });
    }
  }
);


// =========================================
// CONSULTAR ASSINATURA INDIVIDUAL
// =========================================

app.get(
  "/api/mercadopago/consultar-assinatura/:id",
  async (req, res) => {

    try {

      const headers =
        mercadoPagoHeaders();

      if (!headers) {

        return res.status(500).json({
          erro:
            "MERCADOPAGO_ACCESS_TOKEN não configurado no servidor."
        });
      }


      const id =
        String(
          req.params.id || ""
        ).trim();


      if (!id) {

        return res
          .status(400)
          .json({
            erro:
              "ID da assinatura não informado."
          });
      }


      const resposta =
        await fetch(
          `${MP_API}/preapproval/${encodeURIComponent(id)}`,
          {

            method:
              "GET",

            headers
          }
        );


      const dados =
        await lerRespostaJson(
          resposta
        );


      if (!resposta.ok) {

        return res
          .status(resposta.status)
          .json({

            erro:
              "Não foi possível consultar a assinatura.",

            detalhes:
              dados
          });
      }


      return res.json({

        sucesso:
          true,

        id:
          dados.id,

        preapproval_plan_id:
          dados.preapproval_plan_id,

        status:
          dados.status,

        reason:
          dados.reason,

        payer_email:
          dados.payer_email,

        external_reference:
          dados.external_reference,

        init_point:
          dados.init_point,

        back_url:
          dados.back_url,

        auto_recurring:
          dados.auto_recurring,

        next_payment_date:
          dados.next_payment_date,

        date_created:
          dados.date_created,

        last_modified:
          dados.last_modified
      });


    } catch (erro) {

      console.error(
        "Erro ao consultar assinatura Mercado Pago:",
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            "Erro interno ao consultar a assinatura."
        });
    }
  }
);


// =========================================
// INICIAR SERVIDOR
// =========================================

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
