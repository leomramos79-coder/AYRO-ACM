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
    const q = String(req.query.q || "").trim();

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

    const tipoBusca =
      /apartamento|apto/i.test(q) ? "apartamento" :
      /casa em condomínio/i.test(q) ? "casa" :
      /\bcasa\b/i.test(q) ? "casa" :
      /cobertura/i.test(q) ? "cobertura" :
      /terreno/i.test(q) ? "terreno" :
      /galpão|galpao/i.test(q) ? "galpao" :
      /loja|comercial/i.test(q) ? "comercial" :
      /sítio|sitio|fazenda/i.test(q) ? "sitio" :
      "";

    const quartosMatch = q.match(/(\d+)\s*quartos?/i);
    const quartosBusca = quartosMatch
      ? Number(quartosMatch[1])
      : null;

    const areaMatch =
      q.match(/(\d+(?:[.,]\d+)?)\s*m(?:²|2)/i);

    const areaBusca = areaMatch
      ? Number(areaMatch[1].replace(",", "."))
      : null;

    // =====================================
    // BUSCAS EM PORTAIS IMOBILIÁRIOS
    // =====================================

    const consultas = [
      `${q} (site:olx.com.br OR site:zapimoveis.com.br OR site:vivareal.com.br) imóvel venda R$ m²`,

      `${q} (site:chavesnamao.com.br OR site:imovelweb.com.br OR site:wimoveis.com.br) imóvel venda R$ m²`,

      `${q} (site:kenlo.com.br OR site:quintoandar.com.br OR site:casamineira.com.br) imóvel venda R$ m²`
    ];

    const coletados = [];

    for (const consulta of consultas) {

      const url =
        "https://serpapi.com/search.json?engine=google" +
        "&q=" + encodeURIComponent(consulta) +
        "&location=Brazil" +
        "&hl=pt-br" +
        "&gl=br" +
        "&num=20" +
        "&api_key=" + encodeURIComponent(apiKey);

      const resposta = await fetch(url);
      const dados = await resposta.json();

      if (!resposta.ok || dados.error) {

        console.error(
          "SerpAPI:",
          dados.error || resposta.status
        );

        continue;
      }

      coletados.push(
        ...(dados.organic_results || [])
      );
    }

    // =====================================
    // PORTAIS ACEITOS
    // =====================================

    const dominiosImobiliarios =
      /olx\.com\.br|zapimoveis\.com\.br|vivareal\.com\.br|chavesnamao\.com\.br|imovelweb\.com\.br|wimoveis\.com\.br|kenlo\.com\.br|quintoandar\.com\.br|casamineira\.com\.br/i;

    // Bloqueia notícias, redes sociais,
    // prefeitura etc.
    const bloqueados =
      /instagram\.com|facebook\.com|youtube\.com|tiktok\.com|g1\.globo\.com|globo\.com|gov\.br|\.rj\.gov\.br|prefeitura|turismo|notícia|noticia|acidente/i;

    // =====================================
    // IDENTIFICAR PREÇO
    // =====================================

    function numeroPreco(texto) {

      const achados =
        texto.match(
          /R\$\s*[\d.]+(?:,\d{2})?/g
        ) || [];

      for (const p of achados) {

        const n = Number(
          p
            .replace(/R\$\s*/i, "")
            .replace(/\./g, "")
            .replace(",", ".")
        );

        if (n >= 50000) {

          return {
            texto: p,
            valor: n
          };

        }
      }

      return {
        texto: "",
        valor: 0
      };
    }

    // =====================================
    // IDENTIFICAR ÁREA
    // =====================================

    function numeroArea(texto) {

      const achados = [
        ...texto.matchAll(
          /(\d+(?:[.,]\d+)?)\s*m(?:²|2)\b/gi
        )
      ];

      for (const m of achados) {

        const n = Number(
          m[1].replace(",", ".")
        );

        if (
          n >= 15 &&
          n <= 1000000
        ) {

          return {
            texto: `${m[1]} m²`,
            valor: n
          };

        }
      }

      return {
        texto: "",
        valor: 0
      };
    }

    // =====================================
    // ANALISAR RESULTADOS
    // =====================================

    const resultados =
      coletados
        .map(item => {

          const titulo =
            item.title || "";

          const descricao =
            item.snippet || "";

          const link =
            item.link || "";

          const fonte =
            item.source ||
            item.displayed_link ||
            "";

          const texto =
            `${titulo} ${descricao}`;

          const p =
            numeroPreco(
              `${item.price || ""} ${texto}`
            );

          const a =
            numeroArea(texto);

          // =================================
          // TIPO DO IMÓVEL
          // =================================

          let tipoOk = true;

          if (tipoBusca === "apartamento") {

            tipoOk =
              /apartamento|apto|flat|studio/i
                .test(texto) &&
              !/\bcasa\b/i.test(texto);

          }

          else if (tipoBusca === "casa") {

            tipoOk =
              /\bcasa\b|sobrado|condomínio|condominio/i
                .test(texto) &&
              !/apartamento|apto/i.test(texto);

          }

          else if (tipoBusca === "cobertura") {

            tipoOk =
              /cobertura/i.test(texto);

          }

          else if (tipoBusca === "terreno") {

            tipoOk =
              /terreno|lote/i.test(texto);

          }

          else if (tipoBusca === "galpao") {

            tipoOk =
              /galpão|galpao/i.test(texto);

          }

          else if (tipoBusca === "comercial") {

            tipoOk =
              /loja|comercial|sala/i.test(texto);

          }

          else if (tipoBusca === "sitio") {

            tipoOk =
              /sítio|sitio|fazenda|chácara|chacara/i
                .test(texto);

          }

          // =================================
          // QUARTOS
          // =================================

          let quartosOk = true;

          if (
            quartosBusca &&
            /apartamento|casa|cobertura/i
              .test(tipoBusca)
          ) {

            const qm =
              texto.match(
                /(\d+)\s*(?:quartos?|dormitórios?)/i
              );

            quartosOk =
              qm
                ? Math.abs(
                    Number(qm[1]) -
                    quartosBusca
                  ) <= 1
                : true;
          }

          // =================================
          // ÁREA
          // =================================

          let areaOk =
            Boolean(a.valor);

          if (
            areaBusca &&
            a.valor
          ) {

            areaOk =
              Math.abs(
                a.valor - areaBusca
              ) / areaBusca <= 0.45;
          }

          // =================================
          // NÃO ACEITA PÁGINA COLETIVA
          // =================================

          const paginaColetiva =
            /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i
              .test(titulo) ||
            /imóveis\s+(?:para|à)\s+venda/i
              .test(titulo);

          const dominioOk =
            dominiosImobiliarios.test(link);

          const bloqueado =
            bloqueados.test(
              `${link} ${fonte} ${texto}`
            );

          // =================================
          // COMPARÁVEL VÁLIDO
          // =================================

          const comparavelValido =
            Boolean(link) &&
            dominioOk &&
            !bloqueado &&
            !paginaColetiva &&
            Boolean(p.valor) &&
            Boolean(a.valor) &&
            tipoOk &&
            quartosOk &&
            areaOk;

          return {

            titulo,

            descricao,

            link,

            fonte,

            preco:
              p.texto,

            preco_valor:
              p.valor,

            area:
              a.texto,

            area_valor:
              a.valor,

            comparavel_valido:
              comparavelValido
          };

        })

        .filter(
          x => x.link
        );

    // =====================================
    // REMOVE LINKS REPETIDOS
    // =====================================

    const linksVistos =
      new Set();

    const resultadosUnicos =
      resultados.filter(item => {

        const limpo =
          item.link
            .split("?")[0]
            .replace(/\/$/, "");

        if (
          linksVistos.has(limpo)
        ) {
          return false;
        }

        linksVistos.add(limpo);

        return true;
      });

    // =====================================
    // COMPARÁVEIS REAIS
    // =====================================

    const chaves =
      new Set();

    const comparaveis =
      resultadosUnicos
        .filter(item => {

          if (
            !item.comparavel_valido
          ) {
            return false;
          }

          const chave =
            `${Math.round(
              item.preco_valor / 1000
            )}|${Math.round(
              item.area_valor
            )}`;

          if (
            chaves.has(chave)
          ) {
            return false;
          }

          chaves.add(chave);

          return true;

        })

        .slice(0, 8);

    // =====================================
    // REFERÊNCIAS NÃO UTILIZADAS NO ACM
    // =====================================

    const referencias =
      resultadosUnicos
        .filter(
          x => !x.comparavel_valido
        )
        .slice(0, 12);

    // =====================================
    // RESPOSTA PARA O APLICATIVO
    // =====================================

    return res.json({

      sucesso: true,

      // ACM exige no mínimo 3
      minimo_comparaveis: 3,

      amostra_suficiente:
        comparaveis.length >= 3,

      total:
        resultadosUnicos.length,

      total_comparaveis:
        comparaveis.length,

      comparaveis,

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
// MERCADO PAGO
// ASSINATURA AYRO ACM PRO
// R$ 49,90 POR MÊS
// =========================================

app.post(
  "/api/mercadopago/criar-assinatura",
  async (req, res) => {

    try {

      const accessToken =
        process.env
          .MERCADOPAGO_ACCESS_TOKEN;

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

      const baseUrl =
        "https://ayro-acm.onrender.com";

      const assinatura = {

        reason:
          "AYRO ACM Pro",

        external_reference:
          `AYRO-${Date.now()}`,

        payer_email:
          email,

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
          baseUrl,

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
              JSON.stringify(
                assinatura
              )

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

        sucesso: true,

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
  }
);


// =========================================
// MERCADO PAGO
// CONSULTAR ASSINATURA
// =========================================

app.get(
  "/api/mercadopago/consultar-assinatura/:id",
  async (req, res) => {

    try {

      const accessToken =
        process.env
          .MERCADOPAGO_ACCESS_TOKEN;

      if (!accessToken) {

        return res.status(500).json({
          erro:
            "MERCADOPAGO_ACCESS_TOKEN não configurado no servidor."
        });

      }

      const { id } =
        req.params;

      if (!id) {

        return res.status(400).json({
          erro:
            "ID da assinatura não informado."
        });

      }

      const resposta =
        await fetch(
          `https://api.mercadopago.com/preapproval/${encodeURIComponent(id)}`,
          {

            method:
              "GET",

            headers: {

              "Authorization":
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json"

            }

          }
        );

      const dados =
        await resposta.json();

      if (!resposta.ok) {

        console.error(
          "Erro ao consultar assinatura:",
          dados
        );

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

        sucesso: true,

        id:
          dados.id,

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

      return res.status(500).json({
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
