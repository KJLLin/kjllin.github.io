-- =====================================================
-- 22-device-dedupe.sql  登录设备记录去重
--
-- 背景：
--   common.js 的 recordLoginDevice() 每次访问（间隔 >60s）都会
--   INSERT 一条 login_devices，导致同一设备累积几百行，
--   「设备管理」页和设置中心统计失去意义（曾达 664 行 / 16 台设备）。
--
-- 处理：
--   1. 一次性清理：同一 (user_id, browser, os) 只保留最新一条
--   2. 客户端改为「先删同设备旧记录再插入」，本项目已同步修改
--
-- 本脚本可重复执行。
-- =====================================================

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, COALESCE(browser, ''), COALESCE(os, '')
           ORDER BY logged_in_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM public.login_devices
)
DELETE FROM public.login_devices d
USING ranked r
WHERE d.id = r.id
  AND r.rn > 1;
