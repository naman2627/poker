CREATE TABLE "player_stat_periods" (
	"user_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"hands_played" integer DEFAULT 0 NOT NULL,
	"hands_won" integer DEFAULT 0 NOT NULL,
	"showdowns_seen" integer DEFAULT 0 NOT NULL,
	"showdowns_won" integer DEFAULT 0 NOT NULL,
	"net_chips" bigint DEFAULT 0 NOT NULL,
	"biggest_pot" integer DEFAULT 0 NOT NULL,
	"best_hand_category" text,
	"best_hand_at" timestamp with time zone,
	"total_wagered" bigint DEFAULT 0 NOT NULL,
	"longest_win_streak" integer DEFAULT 0 NOT NULL,
	"current_win_streak" integer DEFAULT 0 NOT NULL,
	"big_blind_sum" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_stat_periods_user_id_period_key_pk" PRIMARY KEY("user_id","period_key")
);
--> statement-breakpoint
CREATE TABLE "player_stats" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"hands_played" integer DEFAULT 0 NOT NULL,
	"hands_won" integer DEFAULT 0 NOT NULL,
	"showdowns_seen" integer DEFAULT 0 NOT NULL,
	"showdowns_won" integer DEFAULT 0 NOT NULL,
	"net_chips" bigint DEFAULT 0 NOT NULL,
	"biggest_pot" integer DEFAULT 0 NOT NULL,
	"best_hand_category" text,
	"best_hand_at" timestamp with time zone,
	"total_wagered" bigint DEFAULT 0 NOT NULL,
	"longest_win_streak" integer DEFAULT 0 NOT NULL,
	"current_win_streak" integer DEFAULT 0 NOT NULL,
	"big_blind_sum" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_stat_periods" ADD CONSTRAINT "player_stat_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_stat_periods_key_net_idx" ON "player_stat_periods" USING btree ("period_key","net_chips" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "player_stats_net_idx" ON "player_stats" USING btree ("net_chips" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "player_stats_hands_idx" ON "player_stats" USING btree ("hands_played" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "player_stats_pot_idx" ON "player_stats" USING btree ("biggest_pot" DESC NULLS LAST);
