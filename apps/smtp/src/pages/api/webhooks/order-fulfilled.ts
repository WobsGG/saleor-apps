import { NextWebhookApiHandler, SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next";
import { gql } from "urql";
import { saleorApp } from "../../../saleor-app";
import {
  OrderDetailsFragmentDoc,
  OrderFulfilledWebhookPayloadFragment,
} from "../../../../generated/graphql";
import { SendEventMessagesUseCase } from "../../../modules/event-handlers/send-event-messages.use-case";
import { withOtel } from "@saleor/apps-otel";
import { createLogger } from "../../../logger";
import { createInstrumentedGraphqlClient } from "../../../lib/create-instrumented-graphql-client";
import { SmtpConfigurationService } from "../../../modules/smtp/configuration/smtp-configuration.service";
import { FeatureFlagService } from "../../../modules/feature-flag-service/feature-flag-service";
import { SmtpMetadataManager } from "../../../modules/smtp/configuration/smtp-metadata-manager";
import { createSettingsManager } from "../../../lib/metadata-manager";
import { SmtpEmailSender } from "../../../modules/smtp/smtp-email-sender";
import { EmailCompiler } from "../../../modules/smtp/email-compiler";

const OrderFulfilledWebhookPayload = gql`
  ${OrderDetailsFragmentDoc}

  fragment OrderFulfilledWebhookPayload on OrderFulfilled {
    order {
      ...OrderDetails
    }
  }
`;

const OrderFulfilledGraphqlSubscription = gql`
  ${OrderFulfilledWebhookPayload}
  subscription OrderFulfilled {
    event {
      ...OrderFulfilledWebhookPayload
    }
  }
`;

export const orderFulfilledWebhook = new SaleorAsyncWebhook<OrderFulfilledWebhookPayloadFragment>({
  name: "Order Fulfilled in Saleor",
  webhookPath: "api/webhooks/order-fulfilled",
  asyncEvent: "ORDER_FULFILLED",
  apl: saleorApp.apl,
  subscriptionQueryAst: OrderFulfilledGraphqlSubscription,
});

const logger = createLogger(orderFulfilledWebhook.webhookPath);

const handler: NextWebhookApiHandler<OrderFulfilledWebhookPayloadFragment> = async (
  req,
  res,
  context,
) => {
  logger.debug("Webhook received");

  const { payload, authData } = context;
  const { order } = payload;

  if (!order) {
    logger.error("No order data payload");
    return res.status(200).end();
  }

  const recipientEmail = order.userEmail || order.user?.email;

  if (!recipientEmail?.length) {
    logger.error(`The order ${order.number} had no email recipient set. Aborting.`);
    return res
      .status(200)
      .json({ error: "Email recipient has not been specified in the event payload." });
  }

  const channel = order.channel.slug;
  const client = createInstrumentedGraphqlClient({
    saleorApiUrl: authData.saleorApiUrl,
    token: authData.token,
  });

  const useCase = new SendEventMessagesUseCase({
    emailSender: new SmtpEmailSender(),
    emailCompiler: new EmailCompiler(),
    smtpConfigurationService: new SmtpConfigurationService({
      featureFlagService: new FeatureFlagService({ client }),
      metadataManager: new SmtpMetadataManager(
        createSettingsManager(client, authData.appId),
        authData.saleorApiUrl,
      ),
    }),
  });

  await useCase.sendEventMessages({
    channel,
    event: "ORDER_FULFILLED",
    payload: { order: payload.order },
    recipientEmail,
  });

  return res.status(200).json({ message: "The event has been handled" });
};

export default withOtel(
  orderFulfilledWebhook.createHandler(handler),
  "api/webhooks/order-fulfilled",
);

export const config = {
  api: {
    bodyParser: false,
  },
};
