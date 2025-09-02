import { Client, Message, MessageMedia } from "../types/wa";
import * as XLSX from "xlsx";
import { Expense } from "../models/ExpenseModel";

export class ExcelService {
  private client: Client | undefined;

  constructor(client?: Client) {
    this.client = client;
  }
  public async sendExcelFile(
    userId: string,
    originalMessage: Message
  ): Promise<void> {
    try {
      let expenses = [];
      let fileName = "expenses.xlsx";
      const messageText = originalMessage.body?.toLowerCase() || "";

      const currentYear = new Date().getFullYear().toString();
      const currentMonth = new Date().toISOString().slice(0, 7);
      const monthNames = [
        "january","february","march","april","may","june",
        "july","august","september","october","november","december"
      ];
      const pad2 = (n: number) => String(n).padStart(2, '0');
      // detect explicit month mention like: report january [2025]
      let detectedMonthIndex = -1;
      for (let i = 0; i < monthNames.length; i++) {
        const month = monthNames[i]!;
        if (messageText.includes(month)) { detectedMonthIndex = i; break; }
        // also support short forms like jan, feb, mar, apr, aug, sep, oct, nov, dec
        const short = month.slice(0,3);
        if (messageText.includes(` ${short} `) || messageText.endsWith(` ${short}`) || messageText.startsWith(`${short} `)) {
          detectedMonthIndex = i; break;
        }
      }
      const yearMatch = messageText.match(/\b(20\d{2}|19\d{2})\b/);
      const detectedYear = yearMatch ? yearMatch[1] : null;

      if (messageText.includes("this month")) {
        expenses = await Expense.find({
          userId,
          date: { $regex: `^${currentMonth}` },
        });
        fileName = `expenses_${currentMonth}.xlsx`;
      } else if (messageText.includes("this year")) {
        expenses = await Expense.find({
          userId,
          date: { $regex: `^${currentYear}` },
        });
        fileName = `expenses_${currentYear}.xlsx`;
      } else if (messageText.includes('report') && detectedMonthIndex >= 0) {
        const y = detectedYear || currentYear;
        const m = pad2(detectedMonthIndex + 1);
        const ym = `${y}-${m}`;
        expenses = await Expense.find({ userId, date: { $regex: `^${ym}` } });
        fileName = `expenses_${ym}.xlsx`;
      } else if (messageText.includes('report')) {
        // default report to current month
        expenses = await Expense.find({ userId, date: { $regex: `^${currentMonth}` } });
        fileName = `expenses_${currentMonth}.xlsx`;
      } else {
        expenses = await Expense.find({ userId });
        fileName = "expenses_all.xlsx";
      }

      if (!expenses || expenses.length === 0) {
        if (this.client) {
          await this.client.sendMessage(
            userId,
            "❌ No expenses found for the requested period."
          );
        }
        return;
      }

      // Prepare data rows
      const rows = expenses.map((exp: any) => ({
        Number:
          typeof exp.number === "number"
            ? `#${String(exp.number).padStart(3, "0")}`
            : "",
        Date: exp.date,
        Item: exp.item,
        Price: (Math.round(exp.price * 100) / 100).toFixed(2),
        Currency: exp.currency,
        Image: "", // leave blank by default; add hyperlink only if image exists
      }));

      // Create sheet with a fixed header order
      const headers = ["Number", "Date", "Item", "Price", "Currency", "Image"];
      const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });

      // Apply hyperlinks for Image column
      const baseUrl = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
      const imageColIndex = headers.indexOf("Image");
      if (imageColIndex >= 0) {
        for (let r = 0; r < expenses.length; r++) {
          const exp: any = expenses[r];
          const hasImage = !!exp.imageUrl;
          if (!hasImage) continue;
          const rowIndex = r + 2; // +1 for 1-based rows, +1 for header
          const colIndex = imageColIndex + 1; // 1-based columns
          const cellAddress = XLSX.utils.encode_cell({ r: rowIndex - 1, c: colIndex - 1 });
          const cell = worksheet[cellAddress] || { t: 's', v: '' };
          const shortLink = baseUrl ? `${baseUrl}/v/${String(exp._id)}` : String(exp.imageUrl);
          (cell as any).l = { Target: shortLink, Tooltip: 'Open image' };
          cell.t = 's';
          cell.v = 'View Image';
          worksheet[cellAddress] = cell as any;
        }
      }
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Expenses");

      const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

      const media = new MessageMedia(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer.toString("base64"),
        fileName
      );
      if (this.client) {
        await this.client.sendMessage(userId, media);
        // await this.client.sendMessage(userId, `✅ Sent expense data as *${fileName}*`);
      }
    } catch (error) {
      console.error("❌ Error sending Excel file:", error);
      if (this.client) {
        await this.client.sendMessage(
          userId,
          "Sorry, there was an error generating the Excel file. Please try again."
        );
      }
    }
  }
}
