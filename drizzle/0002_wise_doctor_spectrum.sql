ALTER TABLE "users" ADD COLUMN "totp_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;