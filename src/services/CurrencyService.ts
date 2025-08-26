export class CurrencyService {
    private static currencyMap: { [key: string]: string } = {
        // Common currency names to ISO codes
        'usd': 'USD', 'dollar': 'USD', 'dollars': 'USD', 'us dollar': 'USD', 'american dollar': 'USD',
        'eur': 'EUR', 'euro': 'EUR', 'euros': 'EUR', 'european': 'EUR',
        'gbp': 'GBP', 'pound': 'GBP', 'pounds': 'GBP', 'british pound': 'GBP', 'sterling': 'GBP',
        'inr': 'INR', 'rupee': 'INR', 'rupees': 'INR', 'indian rupee': 'INR', 'indian rupees': 'INR',
        'bdt': 'BDT', 'taka': 'BDT', 'takas': 'BDT', 'bangladeshi taka': 'BDT', 'tk': 'BDT',
        'ngn': 'NGN', 'naira': 'NGN', 'nairas': 'NGN', 'nigerian naira': 'NGN', 'nigerian dollar': 'NGN',
        'pkr': 'PKR', 'pakistani rupee': 'PKR', 'pakistani rupees': 'PKR',
        'lkr': 'LKR', 'sri lankan rupee': 'LKR', 'sri lankan rupees': 'LKR',
        'cad': 'CAD', 'canadian dollar': 'CAD', 'canadian dollars': 'CAD',
        'aud': 'AUD', 'australian dollar': 'AUD', 'australian dollars': 'AUD',
        'jpy': 'JPY', 'yen': 'JPY', 'japanese yen': 'JPY',
        'cny': 'CNY', 'yuan': 'CNY', 'chinese yuan': 'CNY', 'rmb': 'CNY',
        'krw': 'KRW', 'won': 'KRW', 'korean won': 'KRW',
        'thb': 'THB', 'baht': 'THB', 'thai baht': 'THB',
        'myr': 'MYR', 'ringgit': 'MYR', 'malaysian ringgit': 'MYR',
        'sgd': 'SGD', 'singapore dollar': 'SGD', 'singaporean dollar': 'SGD',
        'hkd': 'HKD', 'hong kong dollar': 'HKD',
        'php': 'PHP', 'peso': 'PHP', 'pesos': 'PHP', 'philippine peso': 'PHP',
        'idr': 'IDR', 'rupiah': 'IDR', 'indonesian rupiah': 'IDR',
        'vnd': 'VND', 'dong': 'VND', 'vietnamese dong': 'VND',
    };

    public static detectCurrency(text: string): string | null {
        const normalizedText = text.toLowerCase().trim();

        // Check for exact matches first
        if (this.currencyMap[normalizedText]) {
            return this.currencyMap[normalizedText];
        }

        // Check for partial matches
        for (const [key, value] of Object.entries(this.currencyMap)) {
            if (normalizedText.includes(key)) {
                return value;
            }
        }

        // Check for ISO codes (3 letter uppercase)
        const isoMatch = text.match(/\b[A-Z]{3}\b/);
        if (isoMatch) {
            const iso = isoMatch[0];
            if (Object.values(this.currencyMap).includes(iso)) {
                return iso;
            }
        }

        return null;
    }

    public static formatCurrency(amount: number, currency: string): string {
        const symbols: { [key: string]: string } = {
            'USD': '$', 'EUR': '€', 'GBP': '£', 'JPY': '¥', 'CNY': '¥',
            'INR': '₹', 'BDT': '৳', 'NGN': '₦', 'PKR': '₨', 'LKR': '₨',
        };

        const symbol = symbols[currency];
        if (symbol) {
            return `${symbol}${amount.toFixed(2)}`;
        }
        return `${amount.toFixed(2)} ${currency}`;
    }

    public static getDailyLimit(monthlyBudget: number): number {
        const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
        return Math.round((monthlyBudget / daysInMonth) * 100) / 100;
    }

    public static calculateDynamicDailyLimit(remainingBudget: number): number {
        const today = new Date();
        const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        const remainingDays = lastDayOfMonth - today.getDate() + 1; // including today

        if (remainingDays <= 0) return 0;
        return Math.round((remainingBudget / remainingDays) * 100) / 100;
    }

    public static async getTodaysSpending(userId: string): Promise<number> {
        const today = new Date().toISOString().split('T')[0];
        const { Expense } = await import('../models/ExpenseModel');

        const todaysExpenses = await Expense.find({
            userId,
            date: today
        });

        return todaysExpenses.reduce((total, expense) => total + expense.price, 0);
    }
}