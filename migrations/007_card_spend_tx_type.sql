-- Allow card_spend transactions for daily-limit enforcement
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'send','receive','swap','deposit','withdrawal','admin_adjust',
    'vault_deposit','vault_withdraw','card_fee','card_fee_refund','payment','card_spend'
  ]));
