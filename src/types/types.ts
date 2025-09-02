export interface ExpenseData {
  item: string;
  price: number;
  currency: string;
  date: string;
  imageUrl?: string;
  imageProvider?: 'drive' | 'cloudinary';
  imageRef?: string;
}

export interface GroqExpenseResponse {
  item?: string;
  price?: number;
  currency?: string;
  error?: string;
}

export interface MonthlyTotal {
  month: string;
  year: number;
  totalAmount: number;
  currency: string;
  expenseCount: number;
}

export interface IntentResult {
  intent: "add_expense" | "update_expense" | "export_excel" | "other";
  data: any;
}
