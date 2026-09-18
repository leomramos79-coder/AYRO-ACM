const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "AYRO ACM API online" });
});


// ======================================================
// PESQUISA AYRO ACM
// ======================================================

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
          erro: dados.error || "Erro ao consultar a SerpApi."
        });
      }

      const tipoBusca = /apartamento|apto/i.test(q)
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

          const precosValidos = precos.filter(p => {
            const valor = Number(
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

          const area = areas[0] || "";

          const areaResultado = area
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
              /apartamento|apto|flat|studio/i.test(texto) &&
              !/\bcasa\b/i.test(texto);
          }

          if (tipoBusca === "casa") {
            tipoOk =
              /\bcasa\b|sobrado/i.test(texto) &&
              !/apartamento|apto/i.test(texto);
          }

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

          let areaOk = true;

          if (areaBusca && areaResultado) {
            const diferenca =
              Math.abs(areaResultado - areaBusca) /
              areaBusca;

            areaOk = diferenca <= 0.35;
          }

          const social =
            /instagram\.com|facebook\.com|youtube\.com|tiktok\.com/i.test(
              item.link || ""
            );

          const temPreco = Boolean(preco);
          const temArea = Boolean(areaResultado);

          const paginaColetiva =
            /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i.test(
              texto
            ) ||
            /imóveis\s+(?:para|à)\s+venda/i.test(titulo) ||
            /apartamentos?\s+com\s+\d+\s+quartos?\s+(?:para|à)\s+venda/i.test(
              titulo
            );

          const comparavelValido =
            Boolean(item.link) &&
            temPreco &&
            tipoOk &&
            quartosOk &&
            areaOk &&
            !social &&
            !paginaColetiva;

          console.log("DIAGNOSTICO AYRO", {
            titulo,
            temPreco,
            temArea,
            tipoOk,
            quartosOk,
            areaOk,
            social,
            paginaColetiva,
            comparavelValido
          });

          return {
            titulo,
            descricao,
            link: item.link || "",
            fonte:
              item.source ||
              item.displayed_link ||
              "",
            preco,
            area,
            comparavel_valido: comparavelValido
          };
        })
        .filter(item => item.link);

      const linksVistos = new Set();

      const resultadosUnicos = resultados.filter(item => {
        const linkLimpo = item.link
          .split("?")[0]
          .replace(/\/$/, "");

        if (linksVistos.has(linkLimpo)) {
          return false;
        }

        linksVistos.add(linkLimpo);
        return true;
      });

      const chavesComparaveis = new Set();

      const comparaveis = resultadosUnicos.filter(item => {
        if (!item.comparavel_valido) {
          return false;
        }

        const fonte = String(item.fonte || "")
          .toLowerCase()
          .trim();

        const precoChave = String(item.preco || "")
          .replace(/\s+/g, "")
          .toLowerCase();

        const areaChave = String(item.area || "")
          .replace(/\s+/g, "")
          .toLowerCase();

        if (precoChave && areaChave) {
          const chave =
            `${fonte}|${precoChave}|${areaChave}`;

          if (chavesComparaveis.has(chave)) {
            return false;
          }

          chavesComparaveis.add(chave);
        }

        return true;
      });

      const referencias = resultadosUnicos.filter(
        item => !item.comparavel_valido
      );

      res.json({
        sucesso: true,
        total: resultadosUnicos.length,
        total_comparaveis: comparaveis.length,
        comparaveis,
        referencias,
        resultados: resultadosUnicos
      });
    } catch (erro) {
      console.error(erro);

      res.status(500).json({
        erro: "Erro interno na pesquisa."
      });
    }
  }
);


// ======================================================
// MERCADO PAGO
// ======================================================

const MP_API = "https://api.mercadopago.com";

const AYRO_BACK_URL =
  process.env.AYRO_BACK_URL ||
  "https://ayro-acm.onrender.com";

function mercadoPagoHeaders() {
  const accessToken =
    process.env.MERCADOPAGO_ACCESS_TOKEN;

  if (!accessToken) return null;

  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };
}

async function lerRespostaJson(resposta) {
  const texto = await resposta.text();

  if (!texto) return {};

  try {
    return JSON.parse(texto);
  } catch {
    return { message: texto };
  }
}


// ======================================================
// SUPABASE
// ======================================================

function supabaseConfig() {
  const url = String(
    process.env.SUPABASE_URL || ""
  ).replace(/\/$/, "");

  const secretKey = String(
    process.env.SUPABASE_SECRET_KEY || ""
  ).trim();

  if (!url || !secretKey) {
    return null;
  }

  return {
    url,
    secretKey
  };
}


async function atualizarAssinaturaSupabase(
  email,
  status,
  subscriptionEnd = null
) {
  const config = supabaseConfig();

  if (!config) {
    throw new Error(
      "Supabase não configurado no servidor."
    );
  }

  const emailLimpo = String(email || "")
    .trim()
    .toLowerCase();

  if (!emailLimpo) {
    throw new Error(
      "E-mail não informado para atualização."
    );
  }

  const endpoint =
    `${config.url}/rest/v1/profiles` +
    `?email=eq.${encodeURIComponent(emailLimpo)}`;

  const resposta = await fetch(endpoint, {
    method: "PATCH",

    headers: {
      apikey: config.secretKey,
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },

    body: JSON.stringify({
      subscription_status: status,
      subscription_end: subscriptionEnd
    })
  });

  const dados = await lerRespostaJson(resposta);

  if (!resposta.ok) {
    console.error(
      "Erro Supabase:",
      dados
    );

    throw new Error(
      "Não foi possível atualizar a assinatura no Supabase."
    );
  }

  console.log(
    "SUPABASE ATUALIZADO:",
    emailLimpo,
    status
  );

  return dados;
}


// ======================================================
// CRIAR PLANO
// ======================================================

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
        reason: "AYRO ACM Pro",

        external_reference:
          `AYRO-ACM-PRO-${Date.now()}`,

        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: 49.90,
          currency_id: "BRL"
        },

        back_url: AYRO_BACK_URL
      };

      const resposta = await fetch(
        `${MP_API}/preapproval_plan`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(plano)
        }
      );

      const dados =
        await lerRespostaJson(resposta);

      if (!resposta.ok) {
        return res.status(
          resposta.status
        ).json({
          erro:
            "Não foi possível criar o plano.",
          detalhes: dados
        });
      }

      return res.json({
        sucesso: true,
        plano_id: dados.id,
        status: dados.status,
        checkout_url: dados.init_point,
        init_point: dados.init_point,
        auto_recurring:
          dados.auto_recurring
      });
    } catch (erro) {
      console.error(erro);

      return res.status(500).json({
        erro:
          "Erro interno ao criar o plano."
      });
    }
  }
);


// ======================================================
// ASSINAR PLANO EXISTENTE
// ======================================================

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
          process.env.MERCADOPAGO_PLAN_ID || ""
        ).trim();

      if (planoConfigurado) {
        const consulta = await fetch(
          `${MP_API}/preapproval_plan/${encodeURIComponent(
            planoConfigurado
          )}`,
          {
            method: "GET",
            headers
          }
        );

        const plano =
          await lerRespostaJson(consulta);

        if (!consulta.ok) {
          return res.status(
            consulta.status
          ).json({
            erro:
              "O plano configurado não pôde ser consultado.",
            detalhes: plano
          });
        }

        return res.json({
          sucesso: true,
          plano_id: plano.id,
          status: plano.status,
          checkout_url: plano.init_point,
          init_point: plano.init_point
        });
      }

      return res.status(500).json({
        erro:
          "MERCADOPAGO_PLAN_ID não configurado."
      });
    } catch (erro) {
      console.error(erro);

      return res.status(500).json({
        erro:
          "Erro interno no Mercado Pago."
      });
    }
  }
);


// ======================================================
// CONSULTAR PLANO
// ======================================================

app.get(
  "/api/mercadopago/consultar-plano/:id",
  async (req, res) => {
    try {
      const headers =
        mercadoPagoHeaders();

      if (!headers) {
        return res.status(500).json({
          erro:
            "MERCADOPAGO_ACCESS_TOKEN não configurado."
        });
      }

      const id =
        String(req.params.id || "").trim();

      const resposta = await fetch(
        `${MP_API}/preapproval_plan/${encodeURIComponent(
          id
        )}`,
        {
          method: "GET",
          headers
        }
      );

      const dados =
        await lerRespostaJson(resposta);

      return res.status(
        resposta.status
      ).json(dados);
    } catch (erro) {
      console.error(erro);

      return res.status(500).json({
        erro:
          "Erro ao consultar plano."
      });
    }
  }
);


// ======================================================
// CONSULTAR ASSINATURA
// ======================================================

app.get(
  "/api/mercadopago/consultar-assinatura/:id",
  async (req, res) => {
    try {
      const headers =
        mercadoPagoHeaders();

      if (!headers) {
        return res.status(500).json({
          erro:
            "MERCADOPAGO_ACCESS_TOKEN não configurado."
        });
      }

      const id =
        String(req.params.id || "").trim();

      const resposta = await fetch(
        `${MP_API}/preapproval/${encodeURIComponent(
          id
        )}`,
        {
          method: "GET",
          headers
        }
      );

      const dados =
        await lerRespostaJson(resposta);

      return res.status(
        resposta.status
      ).json(dados);
    } catch (erro) {
      console.error(erro);

      return res.status(500).json({
        erro:
          "Erro ao consultar assinatura."
      });
    }
  }
);


// ======================================================
// PROCESSAR PAGAMENTO
// ======================================================

async function processarPagamento(id) {
  const headers =
    mercadoPagoHeaders();

  if (!headers || !id) {
    return;
  }

  const resposta = await fetch(
    `${MP_API}/v1/payments/${encodeURIComponent(
      id
    )}`,
    {
      method: "GET",
      headers
    }
  );

  const pagamento =
    await lerRespostaJson(resposta);

  if (!resposta.ok) {
    console.error(
      "Pagamento não localizado:",
      pagamento
    );

    return;
  }

  console.log(
    "PAGAMENTO MERCADO PAGO:",
    pagamento.id,
    pagamento.status
  );

  if (pagamento.status !== "approved") {
    return;
  }

  const email =
    pagamento.payer &&
    pagamento.payer.email;

  if (!email) {
    console.error(
      "Pagamento aprovado sem e-mail."
    );

    return;
  }

  await atualizarAssinaturaSupabase(
    email,
    "active",
    null
  );
}


// ======================================================
// PROCESSAR ASSINATURA
// ======================================================

async function processarAssinatura(id) {
  const headers =
    mercadoPagoHeaders();

  if (!headers || !id) {
    return;
  }

  const resposta = await fetch(
    `${MP_API}/preapproval/${encodeURIComponent(
      id
    )}`,
    {
      method: "GET",
      headers
    }
  );

  const assinatura =
    await lerRespostaJson(resposta);

  if (!resposta.ok) {
    console.error(
      "Assinatura não localizada:",
      assinatura
    );

    return;
  }

  const planoConfigurado =
    String(
      process.env.MERCADOPAGO_PLAN_ID || ""
    ).trim();

  if (
    planoConfigurado &&
    assinatura.preapproval_plan_id &&
    assinatura.preapproval_plan_id !==
      planoConfigurado
  ) {
    console.log(
      "Assinatura pertence a outro plano."
    );

    return;
  }

  const email =
    String(
      assinatura.payer_email || ""
    )
      .trim()
      .toLowerCase();

  const status =
    String(
      assinatura.status || ""
    ).toLowerCase();

  console.log(
    "ASSINATURA MERCADO PAGO:",
    id,
    status,
    email
  );

  if (!email) {
    return;
  }

  if (
    status === "authorized" ||
    status === "active"
  ) {
    await atualizarAssinaturaSupabase(
      email,
      "active",
      null
    );

    return;
  }

  if (
    status === "cancelled" ||
    status === "canceled" ||
    status === "paused"
  ) {
    await atualizarAssinaturaSupabase(
      email,
      "inactive",
      new Date().toISOString()
    );
  }
}


// ======================================================
// WEBHOOK MERCADO PAGO
// ======================================================

app.post(
  "/api/mercadopago/webhook",
  async (req, res) => {
    // Mercado Pago recebe confirmação imediatamente
    res.status(200).json({
      recebido: true
    });

    try {
      const body =
        req.body || {};

      const tipo =
        String(
          body.type ||
          body.topic ||
          req.query.type ||
          req.query.topic ||
          ""
        ).toLowerCase();

      const id =
        body.data?.id ||
        body.id ||
        req.query["data.id"] ||
        req.query.id ||
        "";

      console.log(
        "WEBHOOK MERCADO PAGO:",
        tipo,
        id
      );

      if (!id) {
        return;
      }

      if (
        tipo === "payment" ||
        tipo.includes("payment")
      ) {
        await processarPagamento(id);
        return;
      }

      if (
        tipo.includes("preapproval") ||
        tipo.includes("subscription")
      ) {
        await processarAssinatura(id);
      }
    } catch (erro) {
      console.error(
        "ERRO WEBHOOK:",
        erro
      );
    }
  }
);


// ======================================================
// TESTE DO WEBHOOK
// ======================================================

app.get(
  "/api/mercadopago/webhook",
  (req, res) => {
    res.json({
      status:
        "Webhook AYRO ACM online",

      mercado_pago:
        Boolean(
          process.env
            .MERCADOPAGO_ACCESS_TOKEN
        ),

      plano:
        Boolean(
          process.env
            .MERCADOPAGO_PLAN_ID
        ),

      supabase:
        Boolean(
          process.env.SUPABASE_URL &&
          process.env
            .SUPABASE_SECRET_KEY
        )
    });
  }
);


// ======================================================
// SERVIDOR
// ======================================================

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `AYRO ACM API rodando na porta ${PORT}`
  );
});
