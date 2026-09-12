CREATE TABLE "hand_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hand_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"user_id" uuid,
	"street" text NOT NULL,
	"action" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"pot_after" integer DEFAULT 0 NOT NULL,
	"elapsed_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hand_players" (
	"hand_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seat_index" smallint NOT NULL,
	"hole_cards" text[],
	"starting_stack" integer NOT NULL,
	"ending_stack" integer,
	"net" integer,
	"went_to_showdown" boolean DEFAULT false NOT NULL,
	"won" boolean DEFAULT false NOT NULL,
	CONSTRAINT "hand_players_hand_id_seat_index_pk" PRIMARY KEY("hand_id","seat_index")
);
--> statement-breakpoint
CREATE TABLE "hands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"table_id" uuid NOT NULL,
	"hand_number" integer NOT NULL,
	"button_seat" smallint NOT NULL,
	"small_blind" integer NOT NULL,
	"big_blind" integer NOT NULL,
	"board" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"total_pot" integer DEFAULT 0 NOT NULL,
	"deck_seed" text,
	"deck_commit" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seat_index" smallint NOT NULL,
	"buy_in" integer NOT NULL,
	"cash_out" integer,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"host_user_id" uuid,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tables_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "hand_actions" ADD CONSTRAINT "hand_actions_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_actions" ADD CONSTRAINT "hand_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_players" ADD CONSTRAINT "hand_players_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_players" ADD CONSTRAINT "hand_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hands" ADD CONSTRAINT "hands_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hand_actions_hand_seq_unique" ON "hand_actions" USING btree ("hand_id","seq");--> statement-breakpoint
CREATE INDEX "hand_players_user_idx" ON "hand_players" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hands_table_number_unique" ON "hands" USING btree ("table_id","hand_number");--> statement-breakpoint
CREATE INDEX "hands_table_started_idx" ON "hands" USING btree ("table_id","started_at");--> statement-breakpoint
CREATE INDEX "table_sessions_table_idx" ON "table_sessions" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "table_sessions_user_idx" ON "table_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tables_host_idx" ON "tables" USING btree ("host_user_id");