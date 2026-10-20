# Revisão das migrations 0–2: diff semântico e prova de preservação do comportamento humano

Data: 2026-10-20 · Nada foi aplicado (sem `db push`), nada foi commitado, nenhum código de aplicação foi alterado.
Arquivos revisados: `20261021010000_delivery_phone_e164.sql`, `20261021020000_order_authorship_channel.sql`, `20261021030000_order_engine_actor.sql`.

## 0. Veredito

**Nenhum BLOQUEADOR.** O comportamento humano foi preservado, com UMA diferença intencional (aprovada) e algumas diferenças aditivas/internas listadas na seção 9.

Evidências (todas reproduzíveis em `.claude/db-tests/`):

1. **BASE == REMOTO (byte a byte):** o md5 do corpo de `submit_service_order_core`, `submit_service_order`, `create_delivery_order`, `enqueue_order_print_jobs`, `print_actor_name` e dos 4 guards no banco REMOTO é igual ao das migrations atuais do repositório (consulta somente leitura via CLI). Logo, "corpo vigente da base" = "corpo remoto".
2. **Teste diferencial humano (antigo × novo):** a MESMA sequência de **112 passos** (lançar pedido de comanda por cada papel, cerca de 40 cenários de erro de pedido, cerca de 50 de delivery/retirada, produção, cancelamento, lista, `get_delivery_order`, mais dump das tabelas afetadas) foi executada nas migrations ANTIGAS e NOVAS. Resultado: **109 idênticos, 3 diferentes**: os dois passos de telefone de 14 e 15 dígitos (mudança intencional, executados por último para não deslocar o estado) e a lista de chaves de `get_delivery_order` (3 chaves aditivas, seção 9). Mesmos erros, mesmos códigos (`PT400/401/403/404/409`), mesmas mensagens, mesmos totais, mesma baixa de estoque, mesmos itens/setores/modificadores, mesmo payload de impressão, mesmos eventos.
3. **Upgrade sobre banco populado:** `order-engine-upgrade.mjs` (15 checagens): dados antigos intactos, todas as linhas antigas viram `created_via='user'`, constraints validadas.
4. **Suíte nova + mutação:** `order-engine-actor.mjs` (128 checagens) e `mutate-order-engine.mjs` (34/34 mutantes mortos).
5. **Regressão completa:** `run-all` = 3965 ok, 2 falhas que também ocorrem sem as migrations (seção 8).

---

## 1. `submit_service_order_core`

### A) Comportamento antigo preservado
`submit_service_order_core` continua existindo com a **mesma assinatura** `(uuid, jsonb, text default null, boolean default true) returns service_orders` e executa **na mesma ordem** as mesmas checagens de usuário: sessão (`PT401`) → atendimento existe (`PT404`) → papel na empresa (`PT404`) → papel em owner/admin/cashier/attendant (`PT403`). Depois delega ao motor, que repete na mesma ordem: status aberto (`PT409`) → regra origem×tipo (`PT409`) → validação dos itens → trava de estoque → inserção do pedido → itens/modificadores/baixa → impressão.
O corpo do motor é o corpo antigo do núcleo **a partir de "status aberto"**, linha a linha.

### B) Linhas alteradas (diff textual completo: base × motor)
Diff entre o corpo ANTIGO de `submit_service_order_core` e o NOVO `submit_service_order_engine` (a parte de usuário/papel foi movida para o invólucro, ver C):

```diff
--- BASE submit_service_order_core
+++ NOVO submit_service_order_engine
@@ -1,7 +1,9 @@
-create or replace function public.submit_service_order_core(
+create or replace function public.submit_service_order_engine(
   p_service_session_id uuid,
   p_items jsonb,
-  p_origin text default null,
-  p_enqueue_print boolean default true
+  p_origin text,
+  p_enqueue_print boolean,
+  p_actor_user_id uuid,
+  p_actor_via text
 )
 returns public.service_orders
@@ -12,5 +14,4 @@
 declare
   v_session public.service_sessions;
-  v_role public.company_role;
   v_origin text;
   v_order public.service_orders;
@@ -34,6 +35,11 @@
   v_bad text;
 begin
-  if auth.uid() is null then
-    raise exception 'Sessão inválida.' using errcode = 'PT401';
+  -- ator coerente: humano <=> usuário informado; whatsapp_ai <=> sem usuário (mesma regra dos CHECKs de autoria)
+  if p_actor_via is null or p_actor_via not in ('user', 'whatsapp_ai')
+     or (p_actor_via = 'user') <> (p_actor_user_id is not null) then
+    raise exception 'Ator do pedido inválido.' using errcode = 'PT400';
+  end if;
+  if p_origin is null or p_origin not in ('attendant', 'cashier', 'whatsapp', 'delivery') then
+    raise exception 'Origem do pedido inválida.' using errcode = 'PT400';
   end if;
 
@@ -43,20 +49,11 @@
   end if;
 
-  v_role := public.user_role_in_company(v_session.company_id);
-  if v_role is null then
-    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
-  end if;
-  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
-    raise exception 'Você não tem permissão para lançar pedidos.' using errcode = 'PT403';
-  end if;
-
   if v_session.status <> 'open' then
     raise exception 'Este atendimento não está aberto.' using errcode = 'PT409';
   end if;
 
-  -- Origem decidida pelo papel de quem chama (nunca por um valor enviado no payload): só
-  -- attendant tem área operacional própria hoje; os demais papéis autorizados operam como Caixa.
-  v_origin := coalesce(p_origin, case when v_role = 'attendant' then 'attendant' else 'cashier' end);
+  -- Origem decidida por quem chama o motor (a função pública decide pelo papel; nunca por valor do payload).
   -- atendimento de delivery só recebe pedido pelo módulo Delivery (origin 'delivery'); delivery nunca em comanda/mesa
+  v_origin := p_origin;
   if (v_session.kind = 'delivery') is distinct from (v_origin = 'delivery') then
     raise exception 'Pedido de delivery só pode ser lançado pelo módulo Delivery.' using errcode = 'PT409';
@@ -89,6 +86,6 @@
   end if;
 
-  insert into public.service_orders (company_id, service_session_id, origin, status, created_by)
-  values (v_session.company_id, v_session.id, v_origin, 'submitted', auth.uid())
+  insert into public.service_orders (company_id, service_session_id, origin, status, created_by, created_via)
+  values (v_session.company_id, v_session.id, v_origin, 'submitted', p_actor_user_id, p_actor_via)
   returning * into v_order;
 
@@ -252,8 +249,8 @@
 
       insert into public.product_stock_movements (
-        company_id, product_id, movement_type, quantity, reason, balance_after, service_order_item_id, created_by
+        company_id, product_id, movement_type, quantity, reason, balance_after, service_order_item_id, created_by, created_via
       ) values (
         v_session.company_id, v_product.id, 'sale', v_quantity::integer,
-        left('Pedido ' || coalesce(v_label, ''), 200), v_balance, v_item_id, auth.uid()
+        left('Pedido ' || coalesce(v_label, ''), 200), v_balance, v_item_id, p_actor_user_id, p_actor_via
       );
     end if;
```

Leitura do diff:
- Saiu do motor (e foi mantido no invólucro): `auth.uid() is null`, `user_role_in_company`, checagem de papel e a decisão da origem pelo papel.
- Entrou: coerência do ator e origem não nula (só alcançável por chamada interna).
- `auth.uid()` virou `p_actor_user_id` em **2 lugares**: `service_orders.created_by` e `product_stock_movements.created_by`; mais a coluna `created_via` nos dois `INSERT`.
- **Nada mais mudou:** preço (`sale_price + delta`), modificadores (validação e snapshot), setor efetivo, estoque (lock em ordem de id, baixa, movimentação), mensagens e códigos de erro, impressão complementar.

### C) Lógica nova (único código novo do caminho humano)
Invólucro `submit_service_order_core`:

```sql
create or replace function public.submit_service_order_core(
  p_service_session_id uuid,
  p_items jsonb,
  p_origin text default null,
  p_enqueue_print boolean default true
)
returns public.service_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_session from public.service_sessions where id = p_service_session_id;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para lançar pedidos.' using errcode = 'PT403';
  end if;

  -- (o status do atendimento e a regra origem x tipo são checados, nesta ordem, pelo motor)
  -- Origem decidida pelo papel de quem chama (nunca por um valor enviado no payload): só
  -- attendant tem área operacional própria hoje; os demais papéis autorizados operam como Caixa.
  return public.submit_service_order_engine(
    p_service_session_id,
    p_items,
    coalesce(p_origin, case when v_role = 'attendant' then 'attendant' else 'cashier' end),
    p_enqueue_print,
    auth.uid(),
    'user'
  );
end;
$$;
```

### D) Permissões/assinatura
- Assinatura: **idêntica**. `create or replace` preserva os GRANTs. Na tabela da seção 4, `submit_service_order` está **inalterado** (md5 idêntico) e continua chamando `submit_service_order_core(...)`.
- ACL do núcleo no remoto hoje: `{postgres=X, service_role=X}` (sem `authenticated` nem `anon`). **Não mudou.** Observação pré-existente: `service_role` tem EXECUTE no núcleo, mas sem `auth.uid()` ele responde `PT401` (teste 7.7).
- `submit_service_order` (pública): `{postgres, service_role, authenticated}` no remoto, **não mudou**.

### E) Efeitos colaterais
- **1 `SELECT` extra** do atendimento (o invólucro lê para checar papel; o motor lê de novo). Sem lock novo e sem mudança de isolamento.
- A resposta (`returns service_orders`) ganha a coluna **`created_via`** (aditiva): ver seção 9, item 2.

### Confirmações explícitas
| Item | Status | Prova |
|---|---|---|
| Mesma assinatura pública | OK | md5 de `submit_service_order` inalterado; EXECUTE igual (seção 4) |
| Mesmos GRANTs | OK | seção 4 |
| Mesmas validações owner/admin/attendant/cashier | OK | passos S01–S07 do diferencial idênticos (production → `PT403`, attendant inativo → `PT404`, outra empresa → `PT404`, anon → permission denied) |
| Mesmas regras de sessão/comanda/mesa | OK | S09, S10, S26 (fechado/inexistente/delivery) idênticos |
| Mesmas validações de produtos | OK | S15–S25 idênticos |
| Mesmos cálculos | OK | itens, total e `unit_price` idênticos no dump |
| Mesma movimentação de estoque | OK | S35–S37 e dump `stock`/`products_stock` idênticos |
| Mesmo roteamento de produção | OK | dump `items` (setor efetivo) e C01–C03 idênticos |
| Mesma criação de impressão | OK | dump `print_jobs`/`print_job_items` idênticos (payload completo) |
| Mesma idempotência | OK | `submit_service_order` nunca teve idempotência própria; a do delivery (`client_request_id`) está em D40a/D40b idênticos |
| Mesmos erros/códigos humanos | OK | todos os passos de erro idênticos (exceto os dois de E.164, Z01 e Z02) |

---

## 2. `create_delivery_order`

### A) Comportamento antigo preservado
O invólucro novo faz **exatamente** `delivery_assert_operator(p_company_id)` (a mesma primeira linha do corpo antigo) e delega ao motor com o ator humano (`auth.uid()` e o papel retornado). O motor mantém, na mesma ordem: identificador da requisição, tipo, **idempotência (lock advisory e replay)**, configurações, observação, cliente (obrigatório na entrega), telefone, pagamento/troco, endereço **somente de `customer_addresses`** (ativo, mesma empresa, mesmo cliente), taxa (zona → padrão → manual por papel), previsão, sessão, pedido, `delivery_orders`, eventos e impressão.

### B) Diff textual completo (base × motor)
```diff
--- BASE create_delivery_order
+++ NOVO create_delivery_order_engine
@@ -1,17 +1,24 @@
-create function public.create_delivery_order(
+create function public.create_delivery_order_engine(
   p_company_id uuid,
+  p_actor_user_id uuid,
+  p_actor_via text,
+  p_actor_role public.company_role,
   p_client_request_id uuid,
   p_fulfillment text,
   p_items jsonb,
-  p_customer_id uuid default null,
-  p_customer_name text default null,
-  p_customer_phone text default null,
-  p_address_id uuid default null,
-  p_manual_fee numeric default null,
-  p_payment_timing text default null,
-  p_expected_method text default null,
-  p_cash_change_for numeric default null,
-  p_notes text default null
+  p_customer_id uuid,
+  p_customer_name text,
+  p_customer_phone text,
+  p_address_id uuid,
+  p_address jsonb,
+  p_manual_fee numeric,
+  p_payment_timing text,
+  p_expected_method text,
+  p_cash_change_for numeric,
+  p_notes text,
+  p_channel text,
+  p_whatsapp_conversation_id uuid,
+  p_whatsapp_order_draft_id uuid
 )
 returns jsonb
 language plpgsql
@@ -19,11 +26,22 @@
 set search_path = public
 as $$
 declare
-  v_role public.company_role;
+  v_ai boolean := (p_actor_via = 'whatsapp_ai');
+  v_role public.company_role := p_actor_role;
   v_existing public.delivery_orders;
   v_settings jsonb;
   v_customer public.customers;
   v_addr public.customer_addresses;
+  v_clean jsonb;
+  v_a_source_id uuid;
+  v_a_street text;
+  v_a_number text;
+  v_a_complement text;
+  v_a_neigh text;
+  v_a_city text;
+  v_a_state text;
+  v_a_cep text;
+  v_a_ref text;
   v_zone public.delivery_zones;
   v_zone_found boolean := false;
   v_name text;
@@ -44,7 +62,30 @@
   v_deliv timestamptz;
   v_do public.delivery_orders;
 begin
-  v_role := public.delivery_assert_operator(p_company_id);
+  -- Ator, canal e vínculo coerentes (as mesmas regras dos CHECKs de autoria, com erro legível).
+  if p_actor_via is null or p_actor_via not in ('user', 'whatsapp_ai')
+     or (p_actor_via = 'user') <> (p_actor_user_id is not null) then
+    raise exception 'Ator do pedido inválido.' using errcode = 'PT400';
+  end if;
+  if p_channel is null or p_channel not in ('counter', 'phone', 'whatsapp', 'other') then
+    raise exception 'Canal do pedido inválido.' using errcode = 'PT400';
+  end if;
+  if v_ai then
+    if p_actor_role is not null or p_channel <> 'whatsapp'
+       or p_whatsapp_conversation_id is null or p_whatsapp_order_draft_id is null then
+      raise exception 'Pedido do WhatsApp sem a origem completa (conversa e rascunho).' using errcode = 'PT400';
+    end if;
+    -- a IA nunca usa taxa manual, endereço cadastrado nem cliente inexistente na empresa
+    if p_manual_fee is not null or p_address_id is not null then
+      raise exception 'Pedido do WhatsApp não aceita taxa manual nem endereço cadastrado.' using errcode = 'PT400';
+    end if;
+    perform public.assert_company_module(p_company_id, 'delivery');
+    perform public.assert_company_module(p_company_id, 'whatsapp');
+  else
+    if p_whatsapp_conversation_id is not null or p_whatsapp_order_draft_id is not null or p_address is not null then
+      raise exception 'Dados de origem do WhatsApp só valem para o pedido da IA.' using errcode = 'PT400';
+    end if;
+  end if;
 
   if p_client_request_id is null then
     raise exception 'Identificador da requisição ausente.' using errcode = 'PT400';
@@ -89,7 +130,8 @@
     v_name := v_customer.name;
     v_phone := coalesce(public.delivery_digits(p_customer_phone), v_customer.phone, v_customer.whatsapp);
   else
-    if p_fulfillment = 'delivery' then
+    -- sem cliente cadastrado: só a retirada pelo caminho humano; o pedido da IA aceita também a entrega (snapshot do contato)
+    if p_fulfillment = 'delivery' and not v_ai then
       raise exception 'Informe o cliente cadastrado para a entrega.' using errcode = 'PT400';
     end if;
     v_name := nullif(btrim(regexp_replace(coalesce(p_customer_name, ''), '\s+', ' ', 'g')), '');
@@ -100,8 +142,12 @@
       raise exception 'O nome do cliente pode ter no máximo 80 caracteres.' using errcode = 'PT400';
     end if;
     v_phone := public.delivery_digits(p_customer_phone);
-  end if;
-  if v_phone is not null and char_length(v_phone) not between 8 and 13 then
+    if v_ai and v_phone is null then
+      raise exception 'Informe o telefone do contato.' using errcode = 'PT400';
+    end if;
+  end if;
+  -- E.164 sem o "+": 8 a 15 dígitos (mesmo limite do CHECK de delivery_orders.customer_phone)
+  if v_phone is not null and char_length(v_phone) not between 8 and 15 then
     raise exception 'Telefone inválido. Informe o DDD e o número.' using errcode = 'PT400';
   end if;
 
@@ -124,22 +170,38 @@
     end if;
   end if;
 
-  -- Endereço (entrega): SÓ de customer_addresses, ativo, da mesma empresa e do mesmo cliente
+  -- Endereço (entrega). Humano: SÓ de customer_addresses, ativo, da mesma empresa e do mesmo cliente.
+  -- IA: snapshot (p_address) validado e normalizado por delivery_clean_address; nada é gravado em customer_addresses.
   if p_fulfillment = 'delivery' then
-    if p_address_id is null then
-      raise exception 'Informe o endereço de entrega.' using errcode = 'PT400';
-    end if;
-    select * into v_addr from public.customer_addresses where id = p_address_id and company_id = p_company_id;
-    if not found then
-      raise exception 'Endereço não encontrado.' using errcode = 'PT404';
-    end if;
-    if not v_addr.is_active then
-      raise exception 'Este endereço está desativado.' using errcode = 'PT409';
-    end if;
-    if v_addr.customer_id <> p_customer_id then
-      raise exception 'O endereço não pertence a este cliente.' using errcode = 'PT400';
-    end if;
-  elsif p_address_id is not null then
+    if not v_ai then
+      if p_address_id is null then
+        raise exception 'Informe o endereço de entrega.' using errcode = 'PT400';
+      end if;
+      select * into v_addr from public.customer_addresses where id = p_address_id and company_id = p_company_id;
+      if not found then
+        raise exception 'Endereço não encontrado.' using errcode = 'PT404';
+      end if;
+      if not v_addr.is_active then
+        raise exception 'Este endereço está desativado.' using errcode = 'PT409';
+      end if;
+      if v_addr.customer_id <> p_customer_id then
+        raise exception 'O endereço não pertence a este cliente.' using errcode = 'PT400';
+      end if;
+      v_a_source_id := v_addr.id; v_a_street := v_addr.street; v_a_number := v_addr.number; v_a_complement := v_addr.complement;
+      v_a_neigh := v_addr.neighborhood; v_a_city := v_addr.city; v_a_state := v_addr.state; v_a_cep := v_addr.cep;
+      v_a_ref := v_addr.reference;
+    else
+      if p_address is null or jsonb_typeof(p_address) <> 'object' then
+        raise exception 'Informe o endereço de entrega.' using errcode = 'PT400';
+      end if;
+      v_clean := public.delivery_clean_address(
+        null, p_address ->> 'cep', p_address ->> 'street', p_address ->> 'number', p_address ->> 'complement',
+        p_address ->> 'neighborhood', p_address ->> 'city', p_address ->> 'state', p_address ->> 'reference', null, null);
+      v_a_source_id := null; v_a_street := v_clean ->> 'street'; v_a_number := v_clean ->> 'number';
+      v_a_complement := v_clean ->> 'complement'; v_a_neigh := v_clean ->> 'neighborhood'; v_a_city := v_clean ->> 'city';
+      v_a_state := v_clean ->> 'state'; v_a_cep := v_clean ->> 'cep'; v_a_ref := v_clean ->> 'reference';
+    end if;
+  elsif p_address_id is not null or p_address is not null then
     raise exception 'Retirada não usa endereço de entrega.' using errcode = 'PT400';
   end if;
 
@@ -157,29 +219,37 @@
     select * into v_zone
     from public.delivery_zones z
     where z.company_id = p_company_id and z.is_active
-      and z.city_key = public.delivery_norm_text(v_addr.city)
-      and z.neighborhood_key = public.delivery_norm_text(v_addr.neighborhood);
+      and z.city_key = public.delivery_norm_text(v_a_city)
+      and z.neighborhood_key = public.delivery_norm_text(v_a_neigh);
     v_zone_found := found;
 
-    if v_zone_found then
+    if v_ai then
+      -- P1: a IA só entrega em ZONA ATIVA cadastrada. Nunca usa a taxa padrão nem taxa manual.
+      if not v_zone_found then
+        raise exception 'Este endereço está fora das zonas de entrega atendidas.' using errcode = 'PT409';
+      end if;
       v_fee := v_zone.fee; v_source := 'zone';
-    elsif (v_settings ->> 'default_fee') is not null then
-      v_fee := (v_settings ->> 'default_fee')::numeric; v_source := 'default';
-    end if;
-
-    if p_manual_fee is not null then
-      if not (v_settings ->> 'allow_manual_fee')::boolean then
-        raise exception 'O ajuste manual da taxa está desativado nas configurações do Delivery.' using errcode = 'PT403';
-      end if;
-      if v_source <> 'none' then
-        if v_role not in ('owner', 'admin') then
-          raise exception 'Já existe taxa cadastrada para este bairro. Só owner ou admin podem alterá-la.' using errcode = 'PT403';
+    else
+      if v_zone_found then
+        v_fee := v_zone.fee; v_source := 'zone';
+      elsif (v_settings ->> 'default_fee') is not null then
+        v_fee := (v_settings ->> 'default_fee')::numeric; v_source := 'default';
+      end if;
+
+      if p_manual_fee is not null then
+        if not (v_settings ->> 'allow_manual_fee')::boolean then
+          raise exception 'O ajuste manual da taxa está desativado nas configurações do Delivery.' using errcode = 'PT403';
         end if;
-        v_old_fee := jsonb_build_object('fee', v_fee, 'source', v_source);
-      end if;
-      v_fee := p_manual_fee; v_source := 'manual'; v_override := true;
-    elsif v_source = 'none' then
-      raise exception 'Não há taxa cadastrada para este bairro. Cadastre a zona ou informe a taxa manual.' using errcode = 'PT409';
+        if v_source <> 'none' then
+          if v_role not in ('owner', 'admin') then
+            raise exception 'Já existe taxa cadastrada para este bairro. Só owner ou admin podem alterá-la.' using errcode = 'PT403';
+          end if;
+          v_old_fee := jsonb_build_object('fee', v_fee, 'source', v_source);
+        end if;
+        v_fee := p_manual_fee; v_source := 'manual'; v_override := true;
+      elsif v_source = 'none' then
+        raise exception 'Não há taxa cadastrada para este bairro. Cadastre a zona ou informe a taxa manual.' using errcode = 'PT409';
+      end if;
     end if;
 
     v_minutes := coalesce(case when v_zone_found then v_zone.estimated_minutes end, (v_settings ->> 'delivery_minutes')::integer);
@@ -187,11 +257,11 @@
   end if;
 
   -- Atendimento delivery (sem ponto) + pedido pelo MOTOR ÚNICO (preço, modificadores, estoque, setor, snapshots)
-  insert into public.service_sessions (company_id, kind, customer_name, customer_id, status, opened_by)
-  values (p_company_id, 'delivery', v_name, p_customer_id, 'open', auth.uid())
+  insert into public.service_sessions (company_id, kind, customer_name, customer_id, status, opened_by, created_via)
+  values (p_company_id, 'delivery', v_name, p_customer_id, 'open', p_actor_user_id, p_actor_via)
   returning * into v_session;
 
-  v_order := public.submit_service_order_core(v_session.id, p_items, 'delivery', false);
+  v_order := public.submit_service_order_engine(v_session.id, p_items, 'delivery', false, p_actor_user_id, p_actor_via);
 
   select coalesce(sum(i.quantity * i.unit_price), 0)::numeric(12, 2) into v_subtotal
   from public.service_order_items i where i.company_id = p_company_id and i.order_id = v_order.id;
@@ -207,24 +277,30 @@
     customer_id, customer_name, customer_phone, source_address_id,
     addr_street, addr_number, addr_complement, addr_neighborhood, addr_city, addr_state, addr_cep, addr_reference,
     delivery_fee, fee_source, zone_id, estimated_ready_at, estimated_delivery_at,
-    payment_timing, expected_method, cash_change_for, notes, created_by
+    payment_timing, expected_method, cash_change_for, notes, created_by,
+    channel, created_via, whatsapp_conversation_id, whatsapp_order_draft_id
   ) values (
     p_company_id, v_session.id, v_order.id, p_client_request_id, p_fulfillment, 'confirmed',
-    p_customer_id, v_name, v_phone, case when p_fulfillment = 'delivery' then v_addr.id end,
-    case when p_fulfillment = 'delivery' then v_addr.street end, case when p_fulfillment = 'delivery' then v_addr.number end,
-    case when p_fulfillment = 'delivery' then v_addr.complement end, case when p_fulfillment = 'delivery' then v_addr.neighborhood end,
-    case when p_fulfillment = 'delivery' then v_addr.city end, case when p_fulfillment = 'delivery' then v_addr.state end,
-    case when p_fulfillment = 'delivery' then v_addr.cep end, case when p_fulfillment = 'delivery' then v_addr.reference end,
+    p_customer_id, v_name, v_phone, case when p_fulfillment = 'delivery' then v_a_source_id end,
+    case when p_fulfillment = 'delivery' then v_a_street end, case when p_fulfillment = 'delivery' then v_a_number end,
+    case when p_fulfillment = 'delivery' then v_a_complement end, case when p_fulfillment = 'delivery' then v_a_neigh end,
+    case when p_fulfillment = 'delivery' then v_a_city end, case when p_fulfillment = 'delivery' then v_a_state end,
+    case when p_fulfillment = 'delivery' then v_a_cep end, case when p_fulfillment = 'delivery' then v_a_ref end,
     v_fee, v_source, case when v_source = 'zone' then v_zone.id end, v_ready, v_deliv,
-    v_timing, v_method, p_cash_change_for, v_notes, auth.uid()
+    v_timing, v_method, p_cash_change_for, v_notes, p_actor_user_id,
+    p_channel, p_actor_via, p_whatsapp_conversation_id, p_whatsapp_order_draft_id
   ) returning * into v_do;
 
   insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value)
-  values (p_company_id, v_do.id, 'created', auth.uid(),
-          jsonb_build_object('fulfillment', p_fulfillment, 'delivery_fee', v_fee, 'fee_source', v_source, 'total', v_total));
+  values (p_company_id, v_do.id, 'created', p_actor_user_id,
+          jsonb_build_object('fulfillment', p_fulfillment, 'delivery_fee', v_fee, 'fee_source', v_source, 'total', v_total)
+          || case when v_ai then jsonb_build_object(
+               'created_via', 'whatsapp_ai',
+               'whatsapp_conversation_id', p_whatsapp_conversation_id,
+               'whatsapp_order_draft_id', p_whatsapp_order_draft_id) else '{}'::jsonb end);
   if v_override then
     insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, old_value, new_value)
-    values (p_company_id, v_do.id, 'fee_overridden', auth.uid(), v_old_fee,
+    values (p_company_id, v_do.id, 'fee_overridden', p_actor_user_id, v_old_fee,
             jsonb_build_object('fee', v_fee, 'source', 'manual'));
   end if;
 
```

Classificação de cada trecho do diff:

| Trecho | Caminho humano | Caminho `whatsapp_ai` |
|---|---|---|
| Parâmetros novos (`p_actor_*`, `p_address jsonb`, `p_channel`, `p_whatsapp_*`) | recebem sempre `auth.uid()`, o papel, `null`, `'counter'`, `null`, `null` | usados |
| Bloco "ator/canal/vínculo coerentes" | humano: só exige `p_address`/`p_whatsapp_*` nulos (sempre são) | exige canal `whatsapp`, conversa, rascunho, sem papel, sem taxa manual, sem `address_id`; checa módulos delivery **e** whatsapp |
| Cliente sem cadastro | `... and not v_ai`: **entrega sem cliente continua recusada** (`PT400`) | aceita entrega sem cliente (snapshot) |
| Telefone `between 8 and 13` → `8 and 15` | **ÚNICA diferença humana (intencional, aprovada: E.164)** | idem |
| Endereço | ramo `not v_ai` = **corpo antigo literal** (`customer_addresses`, mesmas 4 validações) e depois copia os campos para variáveis `v_a_*` | ramo `v_ai`: `p_address` → `delivery_clean_address` → `v_a_*`; `source_address_id` nulo |
| Zona/taxa | ramo `else` = **corpo antigo literal** (zona → padrão → manual, mesmos erros e papéis) | ramo `v_ai`: zona ativa **obrigatória**, sem padrão, sem manual |
| `INSERT` sessão/pedido/delivery/eventos | `opened_by`/`created_by`/ator = `auth.uid()`; `created_via='user'`; `channel='counter'` (= DEFAULT da coluna) | `NULL`; `whatsapp_ai`; `whatsapp`; vínculos |
| Chamada do motor de pedido | `submit_service_order_engine(..., 'delivery', false, auth.uid(), 'user')` no lugar de `submit_service_order_core(...)` | idem com ator IA |

Equivalência da troca "núcleo → motor" no caminho humano: o núcleo antigo revalidava usuário, papel, status e origem. Isso é redundante aqui: `delivery_assert_operator` já exigiu os mesmos 4 papéis e o módulo na mesma transação, e a sessão acabou de ser criada `open`, `kind='delivery'`, com origem `delivery`.

### C) Invólucro novo
```sql
create or replace function public.create_delivery_order(
  p_company_id uuid,
  p_client_request_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_customer_id uuid default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_address_id uuid default null,
  p_manual_fee numeric default null,
  p_payment_timing text default null,
  p_expected_method text default null,
  p_cash_change_for numeric default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  v_role := public.delivery_assert_operator(p_company_id);

  return public.create_delivery_order_engine(
    p_company_id, auth.uid(), 'user', v_role,
    p_client_request_id, p_fulfillment, p_items,
    p_customer_id, p_customer_name, p_customer_phone,
    p_address_id, null,
    p_manual_fee, p_payment_timing, p_expected_method, p_cash_change_for, p_notes,
    'counter', null, null
  );
end;
$$;
```

### D) Permissões/assinatura
Assinatura e defaults **idênticos** (mesmos nomes e ordem). ACL remota hoje: `{postgres, service_role, authenticated}`, **inalterada** (seção 4).

### Confirmações explícitas
| Item | Status | Prova |
|---|---|---|
| Assinatura pública preservada | OK | seção 4; `create or replace` com a mesma lista de parâmetros |
| Permissões humanas preservadas | OK | D04/D45/D46 (production, outra empresa, anon) idênticos |
| Cliente obrigatório na entrega (humano) | OK | D13 idêntico (`PT400` "Informe o cliente cadastrado…"); mutante "humano pede entrega sem cliente" morto |
| Endereço/taxa/zona iguais (humano) | OK | D27–D39 idênticos (zona, padrão, manual, papéis, `fee_overridden`) |
| `channel` existente continua funcionando | OK | dump: `channel='counter'` nas duas versões |
| Nenhum fluxo humano aceita cliente nulo na entrega | OK | D13 e teste 7.11 |
| Nenhum fluxo humano usa snapshot livre de endereço | OK | `p_address` humano diferente de null → `PT400` "Dados de origem do WhatsApp só valem para o pedido da IA" (teste 5.8); o invólucro humano sempre passa `null` |

---

## 3. Caminho `whatsapp_ai` (isolado)

**Estado real:** hoje NINGUÉM chama o motor com o ator `whatsapp_ai`. A única chamada futura prevista é a RPC de confirmação do rascunho (migration 5, ainda não escrita). Nos testes, o motor é chamado como superusuário.

| Pergunta | Resposta |
|---|---|
| Quem chama o motor interno | Só funções SECURITY DEFINER da base (`create_delivery_order` com ator humano; no futuro `whatsapp_order_confirm` com ator IA). Nenhum papel (anon, authenticated, **service_role**) tem EXECUTE (seção 5). |
| Como `actor='whatsapp_ai'` é definido | Pelo CHAMADOR interno, via `p_actor_via='whatsapp_ai'` e `p_actor_user_id = null`. Nunca vem de payload de usuário. O motor recusa combinações incoerentes (`PT400`). |
| Como `company_id` é derivado | O motor recebe `p_company_id` e confia no chamador interno. **A derivação segura (empresa a partir do job/rascunho no banco, nunca do payload) é responsabilidade da futura `whatsapp_order_confirm`** (padrão `*_job` já usado no auto). Defesa em profundidade no motor: a FK composta `(conversa, empresa)` recusa conversa de outra empresa (teste 5.9), o cliente tem de ser da empresa (5.25), o produto tem de ser da empresa (6.1). |
| Vínculo conversa/rascunho | Colunas `whatsapp_conversation_id`/`whatsapp_order_draft_id` em `delivery_orders`; ambas obrigatórias para o ator IA; `channel='whatsapp'`; índice único por rascunho (1 pedido por rascunho); imutáveis (guard). A FK do rascunho entra com a tabela de rascunhos. |
| `created_by`/`opened_by` NULL e `created_via='whatsapp_ai'` | Gravados em `service_orders`, `service_sessions`, `product_stock_movements`, `print_jobs` e `delivery_orders` (o evento `created` também com ator nulo). |
| Guards contra uso indevido | EXECUTE fechado; coerência do ator no motor; CHECKs de autoria (seção 6); CHECK `delivery_orders_whatsapp_ai_check`; módulos delivery e whatsapp exigidos; FK composta; guards de imutabilidade. |
| Cliente opcional | Sim (`p_customer_id` nulo → snapshot de nome e telefone; nome até 80, telefone 8–15). Se `p_customer_id` vier, vale a mesma validação do humano (existe, da empresa, ativo). Nada é criado, mesclado ou sobrescrito em `customers`. |
| Endereço snapshot | `p_address` jsonb → `delivery_clean_address` (rua, bairro, cidade, UF válida, CEP de 8 dígitos, limites) → colunas `addr_*`. Nada em `customer_addresses`. |
| Zona ativa obrigatória | Sim: sem zona ativa para (cidade, bairro) normalizados → `PT409` "fora das zonas de entrega atendidas", mesmo com `default_fee` configurada (teste 4.6). |
| Sem taxa padrão | Correto (mutante "IA usa taxa padrão" morto). |
| Sem taxa manual | `p_manual_fee` não nulo → `PT400`, inclusive 0 (teste 4.14). |
| Revalidação preço/produto/estoque | **No motor:** produto da empresa, ativo, `available_for_sale`, categoria ativa, modificadores (vínculo, ativo, min/max, obrigatório), estoque (lock em ordem de id, baixa, `PT409`), preço **sempre lido do cadastro** (o preço do payload é ignorado, teste 3.2). **Ainda NÃO existe** a comparação com o snapshot do rascunho ("o preço mudou, peça nova confirmação"): isso é da futura `whatsapp_order_confirm`. |

---

## 4. Assinaturas, corpos e ACL (BASE = REMOTO × NOVO)

| Função | md5 remoto == base | Corpo base × novo | EXECUTE base (PGlite) | EXECUTE novo |
|---|---|---|---|---|
| `create_delivery_order` | igual | alterado (ver seções 1, 2, 10 e migration 1) | anon=0 auth=1 svc=1 pub=0 | anon=0 auth=1 svc=1 pub=0 |
| `create_delivery_order_engine` | — | NOVO | — | anon=0 auth=0 svc=0 pub=0 |
| `enqueue_order_print_jobs` | igual | alterado (ver seções 1, 2, 10 e migration 1) | anon=0 auth=0 svc=1 pub=0 | anon=0 auth=0 svc=1 pub=0 |
| `guard_delivery_order_change` | igual | alterado (ver seções 1, 2, 10 e migration 1) | anon=0 auth=0 svc=1 pub=0 | anon=0 auth=0 svc=1 pub=0 |
| `guard_print_job_change` | igual | alterado (ver seções 1, 2, 10 e migration 1) | anon=0 auth=0 svc=1 pub=0 | anon=0 auth=0 svc=1 pub=0 |
| `guard_service_order_change` | igual | alterado (ver seções 1, 2, 10 e migration 1) | anon=0 auth=0 svc=1 pub=0 | anon=0 auth=0 svc=1 pub=0 |
| `guard_service_session_change` | igual | alterado (ver seções 1, 2, 10 e migration 1) | anon=0 auth=0 svc=1 pub=0 | anon=0 auth=0 svc=1 pub=0 |
| `print_actor_name` | igual | alterado (ver seções 1, 2, 10 e migration 1) | anon=0 auth=0 svc=1 pub=0 | anon=0 auth=0 svc=1 pub=0 |
| `submit_service_order` | igual | inalterado | anon=0 auth=1 svc=1 pub=0 | anon=0 auth=1 svc=1 pub=0 |
| `submit_service_order_core` | igual | alterado (ver seções 1, 2, 10 e migration 1) | anon=0 auth=0 svc=1 pub=0 | anon=0 auth=0 svc=1 pub=0 |
| `submit_service_order_engine` | — | NOVO | — | anon=0 auth=0 svc=0 pub=0 |

`pub` = EXECUTE herdado por PUBLIC. O harness usa o PIOR CASO de privilégios padrão, então `pub=0` e `svc=0` nos motores significam fechado por `REVOKE` explícito. No remoto as ACLs reais são: `create_delivery_order {postgres, service_role, authenticated}`, `submit_service_order {postgres, service_role, authenticated}`, `submit_service_order_core {postgres, service_role}`, `enqueue_order_print_jobs {postgres, service_role}`. As funções públicas mantêm exatamente essas ACLs porque `create or replace` preserva os GRANTs.

## 5. Motores internos: SECURITY DEFINER, search_path, ACL e cadeia de chamadas

| Motor | SECURITY DEFINER | search_path | dono | PUBLIC | anon | authenticated | service_role |
|---|---|---|---|---|---|---|---|
| `submit_service_order_engine(uuid,jsonb,text,boolean,uuid,text)` | sim | `public` | postgres | sem | sem | sem | **sem** |
| `create_delivery_order_engine(uuid,uuid,text,company_role,uuid,text,jsonb,uuid,text,text,uuid,jsonb,numeric,text,text,numeric,text,text,uuid,uuid)` | sim | `public` | postgres | sem | sem | sem | **sem** |

ACL gravada: `{postgres=X/postgres}` (somente o dono). Testes 2.1–2.5: `permission denied` para anon, authenticated e service_role. Dois mutantes (reabrir para service_role) são mortos.

Cadeia de chamadas (encontrada por busca no corpo das funções do banco migrado):

```
authenticated -> submit_service_order(sessão, itens)
                   -> submit_service_order_core(sessão, itens, null, true)      [checa usuário e papel]
                        -> submit_service_order_engine(..., auth.uid(), 'user')

authenticated -> create_delivery_order(...)                                     [delivery_assert_operator]
                   -> create_delivery_order_engine(..., auth.uid(), 'user', papel, ..., 'counter', null, null)
                        -> submit_service_order_engine(..., 'delivery', false, auth.uid(), 'user')

FUTURO (migration 5, ainda não escrita):
service_role -> whatsapp_order_confirm(job, mensagem)                           [deriva empresa, conversa e rascunho do banco]
                   -> create_delivery_order_engine(..., NULL, 'whatsapp_ai', NULL, ..., 'whatsapp', conversa, rascunho)
                        -> submit_service_order_engine(..., 'delivery', false, NULL, 'whatsapp_ai')
```

## 6. `created_by`/`opened_by` NULL: tabelas afetadas

| Tabela | Regra ANTERIOR | Regra NOVA | NULL aceito quando | O que impede NULL fora de `whatsapp_ai` |
|---|---|---|---|---|
| `service_orders` | `created_by NOT NULL` | `created_by` nulo-permitido + `created_via` (`user`/`whatsapp_ai`, default `user`) | só com `created_via='whatsapp_ai'` | CHECK `service_orders_actor_check`: `(created_via='user') = (created_by is not null)`; CHECK `…_created_via_check`; guard (`created_via` imutável) |
| `service_sessions` | `opened_by NOT NULL` | idem com `opened_by` | só com `whatsapp_ai` | `service_sessions_actor_check`; guard |
| `product_stock_movements` | `created_by NOT NULL` | idem | só com `whatsapp_ai` **e** `movement_type='sale'` | `product_stock_movements_actor_check` (equivalência e só venda): entrada, ajuste e estorno da IA recusados |
| `print_jobs` | `created_by NOT NULL` | idem | só com `whatsapp_ai` **e** `job_type='production_order'` | `print_jobs_actor_check`; guard |
| `delivery_orders` | `created_by` já nulo-permitido (`ON DELETE SET NULL`) | + `created_via` e vínculo | `whatsapp_ai` exige `created_by` nulo, `channel='whatsapp'` e rascunho; `user` continua podendo ficar nulo (usuário excluído → `SET NULL`) | `delivery_orders_whatsapp_ai_check`, `…_link_pair_check`, `…_link_channel_check`, FK da conversa, índice único por rascunho; guard |

**`created_by NULL` com `created_via` diferente de `whatsapp_ai` ⇒ REJEITADO.** Provado pelo CHECK de equivalência (testes 1.3, 1.5, 1.7, 1.8, 1.9), pelos mutantes dos CHECKs (mortos) e pelo CHECK `…_created_via_check`, que só admite `user` ou `whatsapp_ai`.

As FKs de `created_by`/`opened_by` continuam `ON DELETE RESTRICT` (nas 4 tabelas), então excluir um usuário nunca "nula" um autor humano nem quebra o CHECK.

## 7. Migration 0 (`20261021010000_delivery_phone_e164.sql`)

Conteúdo integral: `ALTER TABLE delivery_orders DROP CONSTRAINT delivery_orders_customer_phone_check`, `ADD CONSTRAINT … CHECK (customer_phone is null or customer_phone ~ '^[0-9]{8,15}$')` e um `COMMENT`. Mais nada.

| Pergunta | Resposta |
|---|---|
| Altera somente o CHECK | Sim (mais o comentário da coluna; nenhum outro objeto) |
| 8–15 dígitos | Sim: `^[0-9]{8,15}$` |
| Altera tipo | Não (`text`) |
| Altera dados | Não: não há `UPDATE`; alargar a regra nunca invalida linha existente |
| Altera índices | Não |
| Altera RPCs | **Não nesta migration.** A validação equivalente dentro de `create_delivery_order` (`between 8 and 13`) é alargada na migration 2, que já recria essa função. |
| Normaliza registros silenciosamente | Não. A normalização (`delivery_digits`, descarta `+` e máscara) já existia na RPC e não foi alterada. |
| `customers`, `companies`, cobrança | **Não tocados** (continuam 8–13) |

Prova: teste diferencial Z01/Z02 (14 e 15 dígitos: antes `PT400`, agora aceito) e Z03 (16 dígitos: recusado nos dois); `order-engine-upgrade` U10.

## 8. Regressões: as 2 falhas do `run-all`

Rodamos as mesmas suítes sobre o diretório de migrations SEM as três novas (cópia do estado do repositório, `.claude/db-tests/mig-clean`).

| Suíte | Erro | Evidência de baseline (sem as migrations novas) | Toca pedidos, delivery, estoque, impressão, autoria ou whatsapp_ai? |
|---|---|---|---|
| `module-entitlement.mjs` | `FAIL - G2. trial CONVERTED nunca concede, mesmo com o fim original ainda no futuro…` (resultado `30 ok / 1 falhas`; `still_future:false`) | Idêntico em `mig-clean` (30 ok / 1 falha) e no primeiro `run-all`, antes de qualquer migration nova (`baseline-pre-order.out`). O teste depende de o fim do trial "ainda estar no futuro" com datas absolutas; em 2026-10-20 isso deixou de valer. | **Não.** Só entitlement, assinatura e trial. |
| `production.mjs` | Aborta ao carregar o banco: `error: type "public.whatsapp_conversations" does not exist` | Idêntico em `mig-clean` (aborta antes de qualquer cenário) e no baseline inicial. A suíte monta o banco com uma lista de migrations filtrada à mão e deixou de acompanhar migrations posteriores. | **Não carrega nem executa nenhuma migration nova**; falha antes dos testes. Não testa autoria nem IA. |

Observação honesta: no PRIMEIRO baseline (`baseline-pre-order.out`) também falharam `history-metrics.mjs` (1) e `report-metrics.mjs` (3), por arredondamento dependente do relógio ("10,25 → 10"). Nos runs seguintes (com e sem as migrations novas) elas passaram. São falhas intermitentes de relógio, **não** relacionadas; não as contei entre as 2 falhas fixas.

Total do `run-all` final: **3965 checagens ok, 2 falhas, 1 suíte abortada** (67 suítes), `acl2.mjs: AUDITORIA OK`.

## 9. Diferenças e itens que merecem sua decisão

Nenhum é BLOQUEADOR: nenhum altera preço, estoque, validação, permissão, roteamento ou impressão do fluxo humano.

1. **INTENCIONAL (aprovada, P3):** telefone de 14–15 dígitos passa a ser aceito no pedido humano de delivery (antes `PT400`).
2. **ADITIVA, visível na API (a decidir):**
   - `submit_service_order` devolve a linha de `service_orders`; agora ela traz também a coluna **`created_via`** (sempre `'user'` no fluxo humano). Quem lê por nome de campo não é afetado.
   - `get_delivery_order(...)->'order'` é `to_jsonb(delivery_orders) - 'client_request_id' - 'created_by'`; passa a incluir **`created_via`, `whatsapp_conversation_id`, `whatsapp_order_draft_id`** (UUIDs, `null` nos pedidos humanos). Isso aparece também para o entregador. `list_delivery_orders` NÃO mudou (verificado: mesmas chaves, passo G02).
   - **Opção A (recomendada):** aceitar (só UUIDs, inócuos, úteis para a UI). **Opção B:** subtrair essas 3 chaves em `get_delivery_order` (recriar essa função, ~80 linhas, mantendo o JSON idêntico ao de hoje). Aguardo sua escolha; não mexi.
   - As tabelas ganham colunas novas visíveis a `SELECT *` (RLS inalterada).
3. **Inalcançável por humano:** o núcleo, chamado com `p_origin` explícito inválido (não nulo e fora da lista), agora responde `PT400` "Origem do pedido inválida" em vez de falhar por CHECK mais adiante. O núcleo não é executável por `authenticated`, e o único chamador interno antigo passava `'delivery'`.
4. **Mecânica:** 1 `SELECT` extra do atendimento no núcleo humano (seção 1-E).
5. **`print_actor_name`:** `NULL` agora devolve "WhatsApp (IA)". Antes esse caso era impossível (autor era `NOT NULL`).
6. **Guards:** passam a proteger também as colunas novas. Não mudam nada para as colunas antigas (testes 1.13–1.16c).
7. **Pré-existente, não alterado:** `submit_service_order_core` e `enqueue_order_print_jobs` continuam executáveis por `service_role` no remoto. Sem `auth.uid()` o núcleo responde `PT401`. Posso fechar essas ACLs numa migration futura se você quiser.

## 10. `enqueue_order_print_jobs` (diff completo base × novo)

```diff
--- BASE enqueue_order_print_jobs
+++ NOVO enqueue_order_print_jobs
@@ -71,7 +71,7 @@
     end if;
 
     v_job_id := null;
-    insert into public.print_jobs (company_id, print_device_id, job_type, service_order_id, payload, created_by)
+    insert into public.print_jobs (company_id, print_device_id, job_type, service_order_id, payload, created_by, created_via)
     values (
       v_order.company_id, v_device.id, 'production_order', v_order.id,
       public.print_base_payload('production_order', v_device) || jsonb_build_object(
@@ -86,7 +86,7 @@
         'scope', case when v_full then 'full_order' else 'production_sector' end,
         'items', v_items
       ) || coalesce(public.delivery_print_block(v_order.company_id, v_order.service_session_id), '{}'::jsonb),
-      v_order.created_by
+      v_order.created_by, v_order.created_via
     )
     on conflict (print_device_id, service_order_id)
       where job_type = 'production_order' and reprint_of_id is null
```

**A única mudança funcional:** o `INSERT` em `print_jobs` grava também `created_via` herdado do pedido (`v_order.created_via`). Para pedido humano é `'user'` (= DEFAULT), idêntico ao comportamento anterior; para pedido da IA é `'whatsapp_ai'` com `created_by` nulo, permitido pelo CHECK. Sem essa linha, o job do pedido da IA violaria `print_jobs_actor_check` e **nunca imprimiria** (o erro seria engolido pelo bloco de impressão complementar e só apareceria em `print_enqueue_failures`). Bug achado pelos testes (3.11/3.12) e corrigido na migration 2.

Pedidos humanos: o dump `print_jobs`/`print_job_items` do teste diferencial (payload completo, operador, escopo, itens, bloco delivery) é **idêntico**.

## 11. Como reproduzir

```bash
cd ".claude/db-tests"
MIG_DIR="$PWD/mig-clean" node order-engine-differential.mjs rev/diff-old.json   # banco ANTIGO
node order-engine-differential.mjs rev/diff-new.json                            # banco NOVO
node order-engine-differential-compare.mjs                                      # 109 idênticos; diferentes: E.164 (Z01, Z02) e chaves de get_delivery_order (G01)
node review-bodies.mjs                                                          # md5, ACL e definer (use MIG_DIR para a base)
node order-engine-actor.mjs && node order-engine-upgrade.mjs && node mutate-order-engine.mjs
node run-all.mjs
```
Remoto (somente leitura): `.claude/remote/ai2/bodies.sql`, executado com `rq.mjs` (md5 de `prosrc` das 9 funções, comparado com o banco local).
