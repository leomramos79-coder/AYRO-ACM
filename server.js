const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ======================================================
// AYRO ACM PRO
// API
// ======================================================

app.get("/", (req, res) => {
  res.json({
    status: "AYRO ACM API online",
    versao: "PRECISAO-V2",
    minimo_comparaveis: 3
  });
});

// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================

function normalizar(texto = "") {
  return String(texto)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function extrairPreco(texto = "") {
  const encontrados =
    String(texto).match(/R\$\s*[\d.]+(?:,\d{2})?/gi) || [];

  for (const encontrado of encontrados) {
    const valor = Number(
      encontrado
        .replace(/R\$/gi, "")
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")
    );

    if (valor >= 50000) {
      return {
        texto: encontrado.trim(),
        valor
      };
    }
  }

  return {
    texto: "",
    valor: 0
  };
}

function extrairArea(texto = "") {
  const regex =
    /(\d+(?:[.,]\d+)?)\s*m(?:²|2)(?![a-z0-9])/gi;

  const encontrados = [
    ...String(texto).matchAll(regex)
  ];

  for (const encontrado of encontrados) {
    const valor = Number(
      encontrado[1].replace(",", ".")
    );

    if (valor >= 15 && valor <= 1000000) {
      return {
        texto: `${encontrado[1]} m²`,
        valor
      };
    }
  }

  return {
    texto: "",
    valor: 0
  };
}

function mediana(valores = []) {
  if (!valores.length) return 0;

  const lista = [...valores]
    .filter(v => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  if (!lista.length) return 0;

  const meio = Math.floor(lista.length / 2);

  if (lista.length % 2) {
    return lista[meio];
  }

  return (
    lista[meio - 1] +
    lista[meio]
  ) / 2;
}

// ======================================================
// PESQUISA DE COMPARÁVEIS
// ======================================================

app.get(
  ["/api/pesquisar", "/api/search", "/search"],
  async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();

      if (!q) {
        return res.status(400).json({
          erro: "Informe os dados do imóvel."
        });
      }

      const apiKey = process.env.SERPAPI_KEY;

      if (!apiKey) {
        return res.status(500).json({
          erro: "SERPAPI_KEY não configurada."
        });
      }

      // ==================================================
      // IDENTIFICAR DADOS DO IMÓVEL PESQUISADO
      // ==================================================

      let tipoBusca = "";

      if (/apartamento|apto/i.test(q)) {
        tipoBusca = "apartamento";
      } else if (/cobertura/i.test(q)) {
        tipoBusca = "cobertura";
      } else if (/casa em condomínio/i.test(q)) {
        tipoBusca = "casa";
      } else if (/\bcasa\b/i.test(q)) {
        tipoBusca = "casa";
      } else if (/terreno|lote/i.test(q)) {
        tipoBusca = "terreno";
      } else if (/galpão|galpao/i.test(q)) {
        tipoBusca = "galpao";
      } else if (/loja|comercial/i.test(q)) {
        tipoBusca = "comercial";
      } else if (/sítio|sitio|fazenda|chácara|chacara/i.test(q)) {
        tipoBusca = "sitio";
      }

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

      // Bairro vindo do frontend.
      const bairroInformado =
        String(req.query.bairro || "").trim();

      const cidadeInformada =
        String(req.query.cidade || "Teresópolis").trim();

      const ufInformada =
        String(req.query.uf || "RJ").trim();

      // ==================================================
      // CONSULTAS
      // ==================================================

      const localPesquisa =
        bairroInformado
          ? `"${bairroInformado}" "${cidadeInformada}"`
          : `"${cidadeInformada}"`;

      const consultas = [
        `${q} ${localPesquisa} imóvel venda R$ m² site:imovelweb.com.br/propriedades/`,

        `${q} ${localPesquisa} imóvel venda R$ m² site:olx.com.br`,

        `${q} ${localPesquisa} imóvel venda R$ m² site:zapimoveis.com.br`,

        `${q} ${localPesquisa} imóvel venda R$ m² site:vivareal.com.br`,

        `${q} ${localPesquisa} imóvel venda R$ m² site:chavesnamao.com.br`,

        `${q} ${localPesquisa} imóvel venda R$ m² site:kenlo.com.br`
      ];

      const coletados = [];

      for (const consulta of consultas) {
        const url =
          "https://serpapi.com/search.json" +
          "?engine=google" +
          "&q=" + encodeURIComponent(consulta) +
          "&location=Brazil" +
          "&hl=pt-br" +
          "&gl=br" +
          "&num=20" +
          "&api_key=" + encodeURIComponent(apiKey);

        try {
          const resposta = await fetch(url);
          const dados = await resposta.json();

          if (resposta.ok && !dados.error) {
            coletados.push(
              ...(dados.organic_results || [])
            );
          }
        } catch (erro) {
          console.error(
            "Erro consulta SerpAPI:",
            erro
          );
        }
      }

      // ==================================================
      // DOMÍNIOS PERMITIDOS
      // ==================================================

      const dominiosImobiliarios =
        /olx\.com\.br|zapimoveis\.com\.br|vivareal\.com\.br|chavesnamao\.com\.br|imovelweb\.com\.br|wimoveis\.com\.br|kenlo\.com\.br|quintoandar\.com\.br|casamineira\.com\.br/i;

      const bloqueados =
        /instagram\.com|facebook\.com|youtube\.com|tiktok\.com|g1\.globo\.com|globo\.com|gov\.br|prefeitura|turismo|notícia|noticia|acidente/i;

      // ==================================================
      // ANALISAR RESULTADOS
      // ==================================================

      const resultados = coletados
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

          const preco =
            extrairPreco(
              `${item.price || ""} ${texto}`
            );

          const area =
            extrairArea(texto);

          // ==============================================
          // TIPO
          // ==============================================

          let tipoOk = true;

          if (tipoBusca === "apartamento") {
            tipoOk =
              /apartamento|apto|flat|studio/i.test(texto) &&
              !/\bcasa\b/i.test(texto);
          }

          if (tipoBusca === "casa") {
            tipoOk =
              /\bcasa\b|sobrado|condomínio|condominio/i.test(texto) &&
              !/apartamento|apto/i.test(texto);
          }

          if (tipoBusca === "cobertura") {
            tipoOk =
              /cobertura/i.test(texto);
          }

          if (tipoBusca === "terreno") {
            tipoOk =
              /terreno|lote/i.test(texto);
          }

          if (tipoBusca === "galpao") {
            tipoOk =
              /galpão|galpao/i.test(texto);
          }

          if (tipoBusca === "comercial") {
            tipoOk =
              /loja|comercial|sala/i.test(texto);
          }

          if (tipoBusca === "sitio") {
            tipoOk =
              /sítio|sitio|fazenda|chácara|chacara/i.test(texto);
          }

          // ==============================================
          // QUARTOS
          // ==============================================

          let quartosOk = true;

          if (
            quartosBusca &&
            ["apartamento", "casa", "cobertura"].includes(tipoBusca)
          ) {
            const quartosResultado =
              texto.match(
                /(\d+)\s*(?:quartos?|dormitórios?)/i
              );

            if (quartosResultado) {
              quartosOk =
                Math.abs(
                  Number(quartosResultado[1]) -
                  quartosBusca
                ) <= 1;
            }
          }

          // ==============================================
          // ÁREA - MÁXIMO 30% DE DIFERENÇA
          // ==============================================

          let areaOk =
            Boolean(area.valor);

          let diferencaArea = null;

          if (areaBusca && area.valor) {
            diferencaArea =
              Math.abs(
                area.valor - areaBusca
              ) / areaBusca;

            areaOk =
              diferencaArea <= 0.30;
          }

          // ==============================================
          // BAIRRO
          // ==============================================

          let bairroOk = true;

          if (bairroInformado) {
            bairroOk =
              normalizar(texto).includes(
                normalizar(bairroInformado)
              );
          }

          // ==============================================
          // CIDADE
          // ==============================================

          let cidadeOk = true;

          if (cidadeInformada) {
            cidadeOk =
              normalizar(texto).includes(
                normalizar(cidadeInformada)
              );
          }

          // ==============================================
          // PÁGINAS COLETIVAS
          // ==============================================

          const paginaColetiva =
            /\b\d+\s+(?:imóveis|apartamentos|casas|anúncios)\b/i
              .test(titulo) ||
            /imóveis\s+(?:para|à)\s+venda/i
              .test(titulo) ||
            /casas\s+(?:para|à)\s+venda/i
              .test(titulo) ||
            /apartamentos\s+(?:para|à)\s+venda/i
              .test(titulo);

          const dominioOk =
            dominiosImobiliarios.test(link);

          const bloqueado =
            bloqueados.test(
              `${link} ${fonte} ${texto}`
            );

          // ==============================================
          // VALIDAÇÃO FINAL
          // ==============================================

          const comparavelValido =
            Boolean(link) &&
            dominioOk &&
            !bloqueado &&
            !paginaColetiva &&
            Boolean(preco.valor) &&
            Boolean(area.valor) &&
            tipoOk &&
            quartosOk &&
            areaOk &&
            bairroOk &&
            cidadeOk;

          const valorM2 =
            preco.valor && area.valor
              ? preco.valor / area.valor
              : 0;

          return {
            titulo,
            descricao,
            link,
            fonte,

            bairro:
              bairroInformado,

            cidade:
              cidadeInformada,

            uf:
              ufInformada,

            preco:
              preco.texto,

            preco_valor:
              preco.valor,

            area:
              area.texto,

            area_valor:
              area.valor,

            valor_m2:
              valorM2,

            diferenca_area:
              diferencaArea,

            tipo_ok:
              tipoOk,

            quartos_ok:
              quartosOk,

            bairro_ok:
              bairroOk,

            cidade_ok:
              cidadeOk,

            area_ok:
              areaOk,

            comparavel_valido:
              comparavelValido
          };
        })
        .filter(item => item.link);

      // ==================================================
      // REMOVER LINKS DUPLICADOS
      // ==================================================

      const linksVistos =
        new Set();

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

      // ==================================================
      // PRIMEIRA SELEÇÃO
      // ==================================================

      let comparaveis =
        resultadosUnicos.filter(
          item =>
            item.comparavel_valido
        );

      // ==================================================
      // REMOVER DUPLICIDADE DE PREÇO + ÁREA
      // ==================================================

      const chavesComparaveis =
        new Set();

      comparaveis =
        comparaveis.filter(item => {
          const chave =
            `${Math.round(
              item.preco_valor / 1000
            )}-${Math.round(
              item.area_valor
            )}`;

          if (
            chavesComparaveis.has(chave)
          ) {
            return false;
          }

          chavesComparaveis.add(chave);

          return true;
        });

      // ==================================================
      // REMOVER OUTLIERS DE R$/M²
      // ==================================================

      if (comparaveis.length >= 3) {
        const valoresM2 =
          comparaveis.map(
            item => item.valor_m2
          );

        const medianaM2 =
          mediana(valoresM2);

        comparaveis =
          comparaveis.filter(item => {
            const diferenca =
              Math.abs(
                item.valor_m2 -
                medianaM2
              ) / medianaM2;

            // Até 30% da mediana.
            return diferenca <= 0.30;
          });
      }

      // ==================================================
      // ORDENAR POR PROXIMIDADE DE ÁREA
      // ==================================================

      comparaveis.sort((a, b) => {
        const da =
          areaBusca
            ? Math.abs(
                a.area_valor -
                areaBusca
              )
            : 0;

        const db =
          areaBusca
            ? Math.abs(
                b.area_valor -
                areaBusca
              )
            : 0;

        return da - db;
      });

      comparaveis =
        comparaveis.slice(0, 8);

      // ==================================================
      // CALCULAR ACM
      // ==================================================

      let calculo = null;

      if (
        comparaveis.length >= 3 &&
        areaBusca
      ) {
        const valoresM2 =
          comparaveis.map(
            item => item.valor_m2
          );

        const valorM2Recomendado =
          mediana(valoresM2);

        const valorMercado =
          valorM2Recomendado *
          areaBusca;

        const vendaRapida =
          valorMercado * 0.95;

        const valorSuperior =
          valorMercado * 1.07;

        calculo = {
          quantidade_comparaveis:
            comparaveis.length,

          area_avaliada:
            areaBusca,

          valor_m2_recomendado:
            Math.round(
              valorM2Recomendado
            ),

          venda_rapida:
            Math.round(
              vendaRapida
            ),

          valor_mercado_recomendado:
            Math.round(
              valorMercado
            ),

          valor_superior_anuncio:
            Math.round(
              valorSuperior
            )
        };
      }

      // ==================================================
      // REFERÊNCIAS
      // ==================================================

      const linksComparaveis =
        new Set(
          comparaveis.map(
            item => item.link
          )
        );

      const referencias =
        resultadosUnicos
          .filter(
            item =>
              !linksComparaveis.has(
                item.link
              )
          )
          .slice(0, 12);

      // ==================================================
      // RESPOSTA
      // ==================================================

      return res.json({
        sucesso: true,

        versao:
          "PRECISAO-V2",

        minimo_comparaveis:
          3,

        amostra_suficiente:
          comparaveis.length >= 3,

        total_comparaveis:
          comparaveis.length,

        comparaveis,

        referencias,

        calculo,

        mensagem:
          comparaveis.length >= 3
            ? "Amostra suficiente para cálculo do ACM."
            : `Foram encontrados ${comparaveis.length} comparáveis válidos. São necessários no mínimo 3 para calcular o ACM.`
      });
    } catch (erro) {
      console.error(
        "Erro pesquisa AYRO:",
        erro
      );

      return res.status(500).json({
        erro:
          "Erro interno na pesquisa de comparáveis."
      });
    }
  }
);

// ======================================================
// MERCADO PAGO
// ======================================================

const MP_API =
  "https://api.mercadopago.com";

const AYRO_BACK_URL =
  process.env.AYRO_BACK_URL ||
  "https://ayro-acm.onrender.com";

function mercadoPagoHeaders() {
  const token =
    process.env.MERCADOPAGO_ACCESS_TOKEN;

  if (!token) return null;

  return {
    Authorization:
      `Bearer ${token}`,
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
            "MERCADOPAGO_ACCESS_TOKEN não configurado."
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
        return res
          .status(resposta.status)
          .json({
            erro:
              "Não foi possível criar o plano.",
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
          dados.init_point
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
// CRIAR / REUTILIZAR ASSINATURA
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
            "MERCADOPAGO_ACCESS_TOKEN não configurado."
        });
      }

      const planoId =
        String(
          process.env.MERCADOPAGO_PLAN_ID ||
          ""
        ).trim();

      if (planoId) {
        const resposta =
          await fetch(
            `${MP_API}/preapproval_plan/${encodeURIComponent(
              planoId
            )}`,
            {
              method: "GET",
              headers
            }
          );

        const plano =
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

      const resposta =
        await fetch(
          `${MP_API}/preapproval_plan/${encodeURIComponent(
            req.params.id
          )}`,
          {
            method: "GET",
            headers
          }
        );

      const dados =
        await lerRespostaJson(
          resposta
        );

      return res
        .status(resposta.status)
        .json(dados);
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

      const resposta =
        await fetch(
          `${MP_API}/preapproval/${encodeURIComponent(
            req.params.id
          )}`,
          {
            method: "GET",
            headers
          }
        );

      const dados =
        await lerRespostaJson(
          resposta
        );

      return res
        .status(resposta.status)
        .json(dados);
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
// INICIAR
// ======================================================

app.listen(PORT, () => {
  console.log(
    `AYRO ACM API PRECISAO-V2 rodando na porta ${PORT}`
  );
});
