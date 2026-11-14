-- 45-news-entities.sql
-- DeepSeek 状态源的描述里用了十六进制数字实体（&#xA;），
-- 原来的 news_unescape 只处理命名实体，导致摘要里出现字面量「&#xA;」。
-- 这里补上十进制 / 十六进制数字实体的解码，并回填已有数据。

create or replace function public.news_unescape(t text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := coalesce(t, '');
  v_full text;
  v_hex text;
  v_dec text;
  cp integer;
  i integer;
begin
  -- 命名实体（&amp; 放最后，避免二次解码）
  v := replace(v, '&lt;', '<');
  v := replace(v, '&gt;', '>');
  v := replace(v, '&quot;', '"');
  v := replace(v, '&apos;', '''');
  v := replace(v, '&#39;', '''');
  v := replace(v, '&nbsp;', ' ');
  v := replace(v, '&amp;', '&');

  -- 数字实体：&#x1F600; / &#128512;
  -- 注意：regexp_match 只返回捕获组，这里用 substring 取整段匹配
  for i in 1..80 loop
    v_full := substring(v from '&#[xX][0-9A-Fa-f]{1,6};');
    if v_full is not null then
      v_hex := substring(v_full from '&#[xX]([0-9A-Fa-f]{1,6});');
      begin
        cp := ('x' || lpad(v_hex, 6, '0'))::bit(24)::int;
        v := replace(v, v_full, case when cp between 1 and 1114111 then chr(cp) else ' ' end);
      exception when others then
        v := replace(v, v_full, ' ');
      end;
      continue;
    end if;

    v_full := substring(v from '&#[0-9]{1,7};');
    if v_full is not null then
      v_dec := substring(v_full from '&#([0-9]{1,7});');
      begin
        cp := v_dec::int;
        v := replace(v, v_full, case when cp between 1 and 1114111 then chr(cp) else ' ' end);
      exception when others then
        v := replace(v, v_full, ' ');
      end;
      continue;
    end if;

    exit;
  end loop;

  return v;
end;
$$;

-- 回填：清掉存量摘要里的实体残留
update public.news_items
   set summary = btrim(regexp_replace(
         regexp_replace(summary, '&#[xX]?[0-9A-Fa-f]{1,7};', ' ', 'g'),
         '\s+', ' ', 'g'))
 where summary ~ '&#';
