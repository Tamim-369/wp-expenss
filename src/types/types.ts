export interface ExpenseData {
    item: string;
    price: number;
    currency: string;
    date: string;
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

export interface EnvConfig {
    GROQ_API_KEY: string;
    GOOGLE_SHEETS_ID: string;
    GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
    GOOGLE_PRIVATE_KEY: string;
    ALLOWED_NUMBERS?: string;
}

declare global {
    namespace NodeJS {
        interface ProcessEnv extends EnvConfig { }
    }
}