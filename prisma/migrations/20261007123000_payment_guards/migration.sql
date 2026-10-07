-- Preserve legacy subscription history; enforce metadata only for new activation sources.
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_amount_positive" CHECK (amount > 0),
ADD CONSTRAINT "payment_currency_code" CHECK (currency ~ '^[A-Z]{3}$'),
ADD CONSTRAINT "validated_payment_identity" CHECK (status NOT IN ('PAID', 'REVIEW') OR ("validationId" IS NOT NULL AND "paidAt" IS NOT NULL)),
ADD CONSTRAINT "review_payment_reason" CHECK (status <> 'REVIEW' OR "reviewReason" IS NOT NULL);
ALTER TABLE "supplier_subscriptions" ADD CONSTRAINT "activation_metadata" CHECK (
  "activationMethod" IS NULL OR
  ("activatedAt" IS NOT NULL AND ("activationMethod" <> 'ADMIN_MANUAL' OR length(trim("activationReason")) >= 10 AND "activationReason" IS NOT NULL))
);
