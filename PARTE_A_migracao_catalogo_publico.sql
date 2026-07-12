-- ============================================================
-- HIPER PLAY — Parte A: catálogo público integrado (real time)
-- Rodar no SQL Editor do projeto PROD (fzdhuyxwgasjkqyyojwc).
-- Seguro e reversível. Escopo mínimo: leitura anon só de
-- produtos ATIVOS de organização marcada como pública.
-- ============================================================

-- 1) Coluna `linha` nos produtos (3 linhas)
alter table public.products
  add column if not exists linha text not null default 'DiverKids';

alter table public.products
  drop constraint if exists products_linha_check;
alter table public.products
  add constraint products_linha_check
  check (linha in ('DiverKids','HomePlay','EcoPlay'));

-- 2) Flag de catálogo público na organização
alter table public.organizations
  add column if not exists public_catalog boolean not null default false;

-- Marca a org "Hiper Play" como pública
update public.organizations
  set public_catalog = true
  where id = 'cfc1030d-4905-4718-9095-05ca66ec6705';

-- 3) Função que checa a flag sem esbarrar em RLS
create or replace function public.org_is_public(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select public_catalog from public.organizations where id = p_org), false);
$$;

grant execute on function public.org_is_public(uuid) to anon, authenticated;

-- 4) Policy de leitura pública (anon) em products
drop policy if exists products_public_read on public.products;
create policy products_public_read
  on public.products
  for select
  to anon
  using (active and public.org_is_public(org_id));

-- 5) Realtime: adiciona products à publication (idempotente)
do $$
begin
  begin
    alter publication supabase_realtime add table public.products;
  exception when duplicate_object then
    null; -- já está na publication
  end;
end $$;

-- ============================================================
-- Conferência rápida (opcional):
--   select id, name, linha, active from public.products
--     where org_id = 'cfc1030d-4905-4718-9095-05ca66ec6705';
-- Como anon (loja) verá: só as linhas active=true.
-- ============================================================
