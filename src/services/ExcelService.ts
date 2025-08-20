import { Client, Message, MessageMedia } from "whatsapp-web.js";
import XLSX from "xlsx";
import { Expense } from "../models/ExpenseModel";

export class ExcelService {
  private client?: Client;

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
        } else {
          await originalMessage.reply(
            "❌ No expenses found for the requested period."
          );
        }
        return;
      }

      const worksheet = XLSX.utils.json_to_sheet(
        expenses.map((exp) => ({
          Number: typeof exp.number === "number" ? `#${String(exp.number).padStart(3, "0")}` : "",
          Date: exp.date,
          Item: exp.item,
          Price: (Math.round(exp.price * 100) / 100).toFixed(2),
          Currency: exp.currency,
        }))
      );
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
        await this.client.sendMessage(userId, `✅ Sent expense data as *${fileName}*`);
      } else {
        await originalMessage.reply(media);
        await originalMessage.reply(`✅ Sent expense data as ${fileName}`);
      }
    } catch (error) {
      console.error("❌ Error sending Excel file:", error);
      if (this.client) {
        await this.client.sendMessage(
          userId,
          "Sorry, there was an error generating the Excel file. Please try again."
        );
      } else {
        await originalMessage.reply(
          "Sorry, there was an error generating the Excel file. Please try again."
        );
      }
    }
  }
}
