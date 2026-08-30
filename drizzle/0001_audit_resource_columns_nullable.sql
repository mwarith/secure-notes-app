ALTER TABLE "audit_events" ALTER COLUMN "resource_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "resource_id" DROP NOT NULL;