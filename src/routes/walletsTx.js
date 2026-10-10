import { drizzle } from 'drizzle-orm/neon-http';
import { eq, and, sql } from 'drizzle-orm';
import { walletsTransactions, wallets } from '../db/schema.js'; // your existing schema file

const db = drizzle(process.env.DATABASE_URL!);

export const createWalletsTx = async (req, res) => {
  const { toAddress, tokenSymbol, amount } = await req.json();
  const userId = req.user?.id; // your auth middleware

  if (!toAddress || !tokenSymbol || !amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Lock row + check balance
      const [walletRow] = await tx
        .select({ id: wallets.id, balance: wallets.balance, lockedBalance: wallets.lockedBalance })
        .from(wallets)
        .where(and(
          eq(wallets.userId, userId),
          eq(wallets.tokenSymbol, tokenSymbol)
        ))
        .forUpdate();

      const current = parseFloat(walletRow.balance);
      if (current < parseFloat(amount)) throw new Error('Insufficient balance');

      // Atomic debit to locked
      await tx
        .update(wallets)
        .set({ 
          lockedBalance: sql`${wallets.lockedBalance} + ${amount}`,
          balance: sql`${wallets.balance} - ${amount}` 
        })
        .where(eq(wallets.id, walletRow.id));

      // Create pending transaction
      const [txRow] = await tx
        .insert(walletsTransactions)
        .values({
          from_user_id: userId,
          to_address: toAddress,
          token_symbol: tokenSymbol,
          amount,
          status: 'pending',
        })
        .returning();

      return txRow;
    });

    return res.status(201).json({ 
      id: result.id,
      status: 'pending',
      message: 'Transaction submitted — pending admin approval' 
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
};

export const approveWalletsTx = async (req, res) => {
  const { id } = req.params;
  const adminId = req.user?.id;

  const result = await db.transaction(async (tx) => {
    const [txRow] = await tx
      .select()
      .from(walletsTransactions)
      .where(and(eq(walletsTransactions.id, id), eq(walletsTransactions.status, 'pending')))
      .forUpdate();

    if (!txRow) throw new Error('Transaction not found or not pending');

    await tx
      .update(walletsTransactions)
      .set({ 
        status: 'approved', 
        adminId, 
        processedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(walletsTransactions.id, id));

    // TODO: here you actually credit the recipient (on-chain/internal)
    return txRow;
  });

  return res.json({ success: true, status: 'approved' });
};

export const rejectWalletsTx = async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;
  const adminId = req.user?.id;

  const result = await db.transaction(async (tx) => {
    const [txRow] = await tx
      .select()
      .from(walletsTransactions)
      .where(and(eq(walletsTransactions.id, id), eq(walletsTransactions.status, 'pending')))
      .forUpdate();

    if (!txRow) throw new Error('Transaction not found or not pending');

    // Auto-refund to available balance (atomic!)
    await tx
      .update(wallets)
      .set({ 
        lockedBalance: sql`${wallets.lockedBalance} - ${txRow.amount}`,
        balance: sql`${wallets.balance} + ${txRow.amount}` 
      })
      .where(eq(wallets.userId, txRow.from_user_id));

    await tx
      .update(walletsTransactions)
      .set({ 
        status: 'rejected', 
        adminId, 
        admin_note: note,
        updatedAt: new Date()
      })
      .where(eq(walletsTransactions.id, id));

    return txRow;
  });

  return res.json({ success: true, status: 'rejected' });
};
