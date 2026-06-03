-- T7: surface cryptographic attestation reports for confidential
-- compute rentals. Populated by the per-provider poll worker when
-- the pod reaches RUNNING and the provider exposes an attestation
-- URL. Buyers display the link on their rental detail page to
-- verify their workload is in a real TEE.

ALTER TABLE "ExternalRental" ADD COLUMN "attestationUrl" TEXT;
ALTER TABLE "ExternalRental" ADD COLUMN "attestationFetchedAt" TIMESTAMP(3);
