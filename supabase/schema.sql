-- Ask Gita accounts, quota and payments. Run once in the Supabase SQL editor (or with `supabase db push`).
-- Sign-in itself is Supabase Auth (email + one-time code); these tables only track questions and payments.
-- Row level security is on with no policies, so only the server (service role key) can read or write them.

create table if not exists public.ask_accounts (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  free_used    int not null default 0,           -- free questions used (3 are free after sign-up)
  paid_left    int not null default 0,           -- questions left from paid packs
  paid_until   timestamptz,                      -- paid questions expire after this
  total_asked  int not null default 0,
  created_at   timestamptz not null default now()
);
alter table public.ask_accounts enable row level security;

create table if not exists public.ask_payments (
  order_id    text primary key,                  -- Razorpay order id; one order credits one pack, once
  payment_id  text,
  user_id     uuid not null references auth.users (id) on delete cascade,
  amount      int not null,                      -- in the smallest unit (paise)
  currency    text not null,
  questions   int not null,
  created_at  timestamptz not null default now()
);
alter table public.ask_payments enable row level security;

-- Takes one question from the user's allowance, atomically. Free questions are used first, then paid ones.
create or replace function public.ask_take_question(p_user uuid, p_free int)
returns table (allowed boolean, was_free boolean, free_used int, paid_left int, paid_until timestamptz)
language plpgsql security definer set search_path = public as $$
declare r public.ask_accounts; v_free boolean;
begin
  insert into public.ask_accounts (user_id) values (p_user) on conflict do nothing;
  select * into r from public.ask_accounts a where a.user_id = p_user for update;
  v_free := r.free_used < p_free;
  if v_free then
    update public.ask_accounts a set free_used = a.free_used + 1, total_asked = a.total_asked + 1
      where a.user_id = p_user returning * into r;
  elsif r.paid_left > 0 and r.paid_until > now() then
    update public.ask_accounts a set paid_left = a.paid_left - 1, total_asked = a.total_asked + 1
      where a.user_id = p_user returning * into r;
  else
    return query select false, false, r.free_used, r.paid_left, r.paid_until;
    return;
  end if;
  return query select true, v_free, r.free_used, r.paid_left, r.paid_until;
end $$;

-- Gives a question back when the answer failed, so people never pay for an error.
create or replace function public.ask_refund_question(p_user uuid, p_was_free boolean)
returns void language sql security definer set search_path = public as $$
  update public.ask_accounts a set
    free_used = case when p_was_free then greatest(a.free_used - 1, 0) else a.free_used end,
    paid_left = case when p_was_free then a.paid_left else a.paid_left + 1 end,
    total_asked = greatest(a.total_asked - 1, 0)
  where a.user_id = p_user;
$$;

-- Credits a paid pack. Safe to call twice for the same order (checkout callback and webhook both call it).
create or replace function public.ask_record_payment(
  p_order text, p_payment text, p_user uuid, p_amount int, p_currency text, p_questions int, p_days int)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.ask_payments (order_id, payment_id, user_id, amount, currency, questions)
    values (p_order, p_payment, p_user, p_amount, p_currency, p_questions)
    on conflict (order_id) do nothing;
  if not found then return; end if;
  insert into public.ask_accounts (user_id) values (p_user) on conflict do nothing;
  update public.ask_accounts a set
    paid_left = case when a.paid_until > now() then a.paid_left else 0 end + p_questions,
    paid_until = now() + make_interval(days => p_days)
  where a.user_id = p_user;
end $$;

revoke all on function public.ask_take_question(uuid, int) from public, anon, authenticated;
revoke all on function public.ask_refund_question(uuid, boolean) from public, anon, authenticated;
revoke all on function public.ask_record_payment(text, text, uuid, int, text, int, int) from public, anon, authenticated;
grant execute on function public.ask_take_question(uuid, int) to service_role;
grant execute on function public.ask_refund_question(uuid, boolean) to service_role;
grant execute on function public.ask_record_payment(text, text, uuid, int, text, int, int) to service_role;
