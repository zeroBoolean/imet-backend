ALTER TABLE "rfqs" DROP CONSTRAINT "rfq_valid_budget";
ALTER TABLE "rfqs" ADD CONSTRAINT "rfq_valid_budget" CHECK (
 ("targetBudget" IS NULL AND "budgetCurrency" IS NULL) OR
 ("targetBudget" IS NOT NULL AND "budgetCurrency" IS NOT NULL AND "targetBudget" >= 0 AND "budgetCurrency" ~ '^[A-Z]{3}$')
);
