-- Canonical keys make the unique cache-key index enforce resource/field/language uniqueness.
-- Separate additive migration preserves the already-applied translation migration history.
ALTER TABLE content_translations ADD CONSTRAINT translation_cache_key_guard CHECK (
  "cacheKey" = (
    CASE
      WHEN "machineId" IS NOT NULL THEN 'MACHINERY:' || "machineId"
      WHEN "specificationId" IS NOT NULL THEN 'SPECIFICATION:' || "specificationId"
      WHEN "supplierId" IS NOT NULL THEN 'SUPPLIER:' || "supplierId"
      ELSE 'REVIEW:' || "reviewId"
    END || ':' || field::text || ':' || "targetLanguage"::text
  )
);
