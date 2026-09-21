/* ==========================================
   MERCADO PAGO
   ASSINATURA AYRO ACM PRO
   R$ 49,90 / MÊS
========================================== */

app.post(
  '/api/mercadopago/criar-assinatura',

  async (req, res) => {
    try {
      const accessToken =
        process.env
          .MP_ACCESS_TOKEN;

      if (!accessToken) {
        return res
          .status(500)
          .json({
            erro:
              'MP_ACCESS_TOKEN não configurado no servidor.'
          });
      }

      const {
        email
      } = req.body || {};

      if (!email) {
        return res
          .status(400)
          .json({
            erro:
              'Informe o e-mail do cliente.'
          });
      }

      const baseUrl =
        'https://ayro-acm.onrender.com';

      const assinatura = {
        reason:
          'AYRO ACM Pro',

        external_reference:
          `AYRO-${Date.now()}`,

        payer_email:
          email,

        auto_recurring: {
          frequency: 1,

          frequency_type:
            'months',

          transaction_amount:
            49.90,

          currency_id:
            'BRL'
        },

        back_url:
          baseUrl,

        status:
          'pending'
      };

      const resposta =
        await fetch(
          'https://api.mercadopago.com/preapproval',

          {
            method:
              'POST',

            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify(
                assinatura
              )
          }
        );

      const dados =
        await resposta.json();

      if (
        !resposta.ok
      ) {
        console.error(
          'Erro Mercado Pago:',
          dados
        );

        return res
          .status(
            resposta.status
          )
          .json({
            erro:
              'Não foi possível criar a assinatura.',

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
        'Erro ao criar assinatura Mercado Pago:',
        erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Erro interno ao criar assinatura.'
        });
    }
  }
);


/* ==========================================
   MERCADO PAGO - AYRO ACM PRO V12
   CONSULTA DE ASSINATURA + WEBHOOK
========================================== */

const mpAccessToken = () =>
  process.env.MP_ACCESS_TOKEN || '';


async function mpGet(path) {

  const token =
    mpAccessToken();

  if (!token) {
    throw new Error(
      'MP_ACCESS_TOKEN não configurado no servidor.'
    );
  }

  const resposta =
    await fetch(
      `https://api.mercadopago.com${path}`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );

  const dados =
    await resposta
      .json()
      .catch(
        () => ({})
      );

  if (!resposta.ok) {

    const erro =
      new Error(
        `Mercado Pago HTTP ${resposta.status}`
      );

    erro.dados =
      dados;

    throw erro;
  }

  return dados;
}


/* ==========================================
   CONSULTAR ASSINATURA
========================================== */

app.get(
  '/api/mercadopago/assinatura/:id',

  async (req, res) => {

    try {

      const id =
        String(
          req.params.id || ''
        ).trim();

      if (!id) {

        return res
          .status(400)
          .json({
            erro:
              'ID da assinatura não informado.'
          });

      }

      const dados =
        await mpGet(
          `/preapproval/${encodeURIComponent(id)}`
        );

      return res.json({

        sucesso:
          true,

        id:
          dados.id,

        status:
          dados.status,

        payer_email:
          dados.payer_email,

        external_reference:
          dados.external_reference,

        next_payment_date:
          dados.next_payment_date || null

      });

    } catch (erro) {

      console.error(
        'Erro ao consultar assinatura Mercado Pago:',
        erro.dados || erro
      );

      return res
        .status(500)
        .json({
          erro:
            'Não foi possível consultar a assinatura.'
        });

    }

  }
);


/* ==========================================
   WEBHOOK MERCADO PAGO
========================================== */

app.post(
  '/api/mercadopago/webhook',

  async (req, res) => {

    /*
      O Mercado Pago precisa receber
      uma resposta rapidamente.
    */

    res.sendStatus(200);

    try {

      const body =
        req.body || {};

      const tipo =
        String(
          body.type ||
          body.topic ||
          ''
        ).trim();

      const dataId =
        String(
          body?.data?.id ||
          body.id ||
          ''
        ).trim();


      if (!dataId) {

        console.log(
          'Webhook Mercado Pago recebido sem data.id:',
          body
        );

        return;
      }


      /* ======================================
         ATUALIZAÇÃO DA ASSINATURA
      ====================================== */

      if (
        tipo ===
          'subscription_preapproval' ||
        tipo ===
          'preapproval'
      ) {

        const assinatura =
          await mpGet(
            `/preapproval/${encodeURIComponent(dataId)}`
          );

        console.log(
          'MP assinatura atualizada:',
          {

            id:
              assinatura.id,

            status:
              assinatura.status,

            payer_email:
              assinatura.payer_email,

            external_reference:
              assinatura.external_reference

          }
        );

        return;
      }


      /* ======================================
         PAGAMENTO
      ====================================== */

      if (
        tipo ===
        'payment'
      ) {

        const pagamento =
          await mpGet(
            `/v1/payments/${encodeURIComponent(dataId)}`
          );

        console.log(
          'MP pagamento atualizado:',
          {

            id:
              pagamento.id,

            status:
              pagamento.status,

            external_reference:
              pagamento.external_reference,

            transaction_amount:
              pagamento.transaction_amount,

            payment_method_id:
              pagamento.payment_method_id

          }
        );

        return;
      }


      /* ======================================
         PAGAMENTO RECORRENTE DA ASSINATURA
      ====================================== */

      if (
        tipo ===
        'subscription_authorized_payment'
      ) {

        const fatura =
          await mpGet(
            `/authorized_payments/${encodeURIComponent(dataId)}`
          );

        console.log(
          'MP fatura de assinatura atualizada:',
          {

            id:
              fatura.id,

            status:
              fatura.status,

            preapproval_id:
              fatura.preapproval_id

          }
        );

        return;
      }


      console.log(
        'Webhook Mercado Pago - evento não tratado:',
        tipo,
        dataId
      );


    } catch (erro) {

      console.error(
        'Erro ao processar webhook Mercado Pago:',
        erro.dados || erro
      );

    }

  }
);


/* ==========================================
   PORTA DO SERVIDOR
========================================== */

const PORT =
  process.env.PORT ||
  3000;


if (
  require.main === module
) {

  app.listen(

    PORT,

    () =>
      console.log(
        `AYRO ACM API PRECISAO-V12-MP rodando na porta ${PORT}`
      )

  );

}


/* ==========================================
   EXPORTS
========================================== */

module.exports = {

  app,

  dadosDaBusca,

  dadosDaUrl,

  ehLinkIndividual,

  extrairDaPagina,

  avaliarItem,

  calcularAvaliacao

};
