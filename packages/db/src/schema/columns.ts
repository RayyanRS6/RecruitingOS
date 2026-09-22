import { timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "../ids";

export const id = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
export const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow().$onUpdateFn(() => new Date().toISOString());
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
