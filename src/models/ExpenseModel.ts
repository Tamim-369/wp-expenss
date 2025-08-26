import { Schema, Document, model } from "mongoose";

interface IBudget extends Document {
  userId: string;
  month: string;
  budget: number;
  currency: string;
}

interface IExpense extends Document {
  userId: string;
  item: string;
  price: number;
  currency: string;
  date: string;
  number: number;
}

interface IConversation extends Document {
  userId: string;
  message: string;
  timestamp: Date;
}

const BudgetSchema = new Schema<IBudget>({
  userId: { type: String, required: true },
  month: { type: String, required: true },
  budget: { type: Number, required: true },
  currency: { type: String, required: true, default: "USD" },
});

const ExpenseSchema = new Schema<IExpense>({
  userId: { type: String, required: true },
  item: { type: String, required: true },
  price: { type: Number, required: true },
  currency: { type: String, required: true, default: "USD" },
  date: { type: String, required: true },
  number: { type: Number, required: true, index: true },
});

const ConversationSchema = new Schema<IConversation>({
  userId: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});

export const Budget = model<IBudget>("Budget", BudgetSchema);
export const Expense = model<IExpense>("Expense", ExpenseSchema);
export const Conversation = model<IConversation>(
  "Conversation",
  ConversationSchema
);

// Counter for running expense numbers
interface ICounter extends Document {
  key: string;
  seq: number;
}

const CounterSchema = new Schema<ICounter>({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, required: true, default: 0 },
});

export const Counter = model<ICounter>("Counter", CounterSchema);

// User state for onboarding
interface IUser extends Document {
  userId: string;
  state: 'new' | 'awaiting_budget' | 'awaiting_currency' | 'active';
  currency?: string;
  createdAt: Date;
}

const UserSchema = new Schema<IUser>({
  userId: { type: String, required: true, unique: true },
  state: { type: String, required: true, default: 'new' },
  currency: { type: String },
  createdAt: { type: Date, default: Date.now },
});

export const User = model<IUser>("User", UserSchema);
