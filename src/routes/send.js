import { drizzle } from 'drizzle-orm/neon-http';
import { eq, and, sql } from 'drizzle-orm';
import { sendTransactions, balances } from '../db/schema.js'; // your schema file

const db = drizzle(process.env.DATABASE_URL!);

export const createSend = async (req, res) => {
  const { toAddress, tokenSymbol, amount } = await req.json();
  const userId = req.user?.id; // from your auth middleware

  if (!toAddress || !tokenSymbol || !amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Lock balance row
      const [balanceRow] = await tx
        .select({ id: balances.id, balance: balances.balance, lockedBalance: balances.lockedBalance })
        .from(balances)
        .where(and(
          eq(balances.userId, userId),
          eq(balances.tokenSymbol, tokenSymbol)
        ))
        .forUpdate();

      const current = parseFloat(balanceRow.balance);
      if (current < parseFloat(amount)) throw new Error('Insufficient balance');

      // Move to locked (atomic)
      await tx
        .update(balances)
        .set({ 
          lockedBalance: sql`${balances.lockedBalance} + ${amount}`,
          balance: sql`${balances.balance} - ${amount}` 
        })
        .where(eq(balances.id, balanceRow.id));

      // Create pending record
      const [txRow] = await tx
        .insert(sendTransactions)
        .values({
          fromUserId: userId,
          toAddress,
          tokenSymbol,
          amount,
          status: 'pending',
        })
        .returning();

      return txRow;
    });

    return res.status(201).json({ 
      id: result.id, 
      status: 'pending',
      message: 'Transaction created — waiting for admin approval' 
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
};

export const approveSend = async (req, res) => {
  const { id } = req.params;
  const adminId = req.user?.id;

  const result = await db.transaction(async (tx) => {
    const [txRow] = await tx
      .select()
      .from(sendTransactions)
      .where(and(eq(sendTransactions.id, id), eq(sendTransactions.status, 'pending')))
      .forUpdate();

    if (!txRow) throw new Error('Not pending');

    await tx
      .update(sendTransactions)
      .set({ status: 'approved', adminId, processedAt: new Date(), updatedAt: new Date() })
      .where(eq(sendTransactions.id, id));

    // TODO: here you actually credit the recipient (on-chain or internal)
    return txRow;
  });

  res.json({ success: true, status: 'approved' });
};

export const rejectSend = async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;
  const adminId = req.user?.id;

  const result = await db.transaction(async (tx) => {
    const [txRow] = await tx
      .select()
      .from(sendTransactions)
      .where(and(eq(sendTransactions.id, id), eq(sendTransactions.status, 'pending')))
      .forUpdate();

    if (!txRow) throw new Error('Not pending');

    // Refund to available
    await tx
      .update(balances)
      .set({ 
        lockedBalance: sql`${balances.lockedBalance} - ${txRow.amount}`,
        balance: sql`${balances.balance} + ${txRow.amount}` 
      })
      .where(eq(balances.userId, txRow.fromUserId));

    await tx
      .update(sendTransactions)
      .set({ status: 'rejected', adminId, adminNote: note, updatedAt: new Date() })
      .where(eq(sendTransactions.id, id));

    return txRow;
  });

  res.json({ success: true, status: 'rejected' });
};
