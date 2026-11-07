import { BellOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Popover, Space, Switch, Tag, notification } from "antd";
import { useEffect, useRef, useState } from "react";
import {
  loadConnectionNotifications,
  saveConnectionNotifications,
  showConnectionNotification,
  supportsDesktopNotifications,
} from "../lib/connectionNotifications";

export function ConnectionStatus({ connected, retryAttempt, retryDelayMs, updatedAt, onReconnect }: {
  connected: boolean;
  retryAttempt: number;
  retryDelayMs: number;
  updatedAt: string;
  onReconnect: () => void;
}) {
  const [api, contextHolder] = notification.useNotification();
  const [enabled, setEnabled] = useState(loadConnectionNotifications);
  const [requesting, setRequesting] = useState(false);
  const hadConnection = useRef(false);
  const warned = useRef(false);
  const lastWarningAt = useRef<number | null>(null);
  const supported = supportsDesktopNotifications();

  useEffect(() => {
    if (connected) {
      hadConnection.current = true;
      if (warned.current) {
        warned.current = false;
        api.success({ key: "market-connection", title: "连接已恢复", description: "已重新连接本地行情服务。", duration: 3 });
        if (enabled) showConnectionNotification("已重新连接本地行情服务。");
      }
      return;
    }
    // Ignore startup and brief reloads. Flapping connections notify at most once a minute.
    if (!hadConnection.current) return;
    const timer = window.setTimeout(() => {
      if (lastWarningAt.current !== null && Date.now() - lastWarningAt.current < 60_000) return;
      lastWarningAt.current = Date.now();
      warned.current = true;
      api.warning({ key: "market-connection", title: "行情连接已断开", description: "正在自动重连，当前显示的数据可能不是最新。", duration: 6 });
      if (enabled) showConnectionNotification("行情连接已断开，正在自动重连。当前数据可能不是最新。");
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [connected, enabled, api]);

  const toggleNotifications = async (next: boolean) => {
    if (!next) {
      setEnabled(false);
      saveConnectionNotifications(false);
      return;
    }
    if (!supported) return;
    setRequesting(true);
    try {
      const permission = await Notification.requestPermission();
      const granted = permission === "granted";
      setEnabled(granted);
      saveConnectionNotifications(granted);
      api.info({
        title: granted ? "系统连接提醒已开启" : "系统提醒未开启",
        description: granted ? "窗口在后台时提醒断线和恢复；前台使用页内提示。" : "可在浏览器或系统设置中允许通知，页内连接提示仍会显示。",
        duration: 4,
      });
    } catch {
      api.info({ title: "当前环境无法申请系统提醒", description: "仍会显示页内连接提示。", duration: 4 });
    } finally {
      setRequesting(false);
    }
  };

  const label = connected ? "已连接" : retryAttempt ? "重连中" : "连接中";
  const detail = connected
    ? "已连接本地服务；行情更新时间请查看右侧时间"
    : `${retryDelayMs ? `自动重试间隔 ${retryDelayMs / 1000} 秒。` : "正在尝试连接。"}${updatedAt ? "当前显示上次收到的数据。" : "等待首次行情数据。"}`;

  return (
    <div className="connection-status">
      {contextHolder}
      <span role="status" aria-live="polite" title={detail}>
        <Tag color={connected ? "success" : retryAttempt ? "warning" : "processing"}>{label}</Tag>
      </span>
      {!connected && (
        <Button size="small" icon={<ReloadOutlined />} onClick={onReconnect} title="立即重新连接本地行情服务">立即重连</Button>
      )}
      {updatedAt && <span className="updated" title={updatedAt}>更新 {updatedAt.slice(11)}</span>}
      <Popover trigger="click" placement="bottomLeft" content={
        <div className="connection-preferences">
          <Space>
            <span>系统连接提醒</span>
            <Switch checked={enabled} loading={requesting} disabled={!supported} onChange={(next) => void toggleNotifications(next)} aria-label="系统连接提醒" />
          </Space>
          <p className="muted">{supported ? "默认关闭。后台提醒断线和恢复，前台显示页内提示。" : "当前环境不支持系统通知，仍提供页内连接提示。"}</p>
          <Button size="small" disabled={!enabled} onClick={() => {
            const delivered = showConnectionNotification("这是一条测试连接提醒。", false);
            api.info({ title: delivered ? "测试提醒已提交系统" : "系统提醒暂不可用", description: delivered ? "若未看到，请检查系统通知权限和勿扰模式。" : "请检查通知权限；页内提示仍可使用。", duration: 4 });
          }}>测试提醒</Button>
        </div>
      }>
        <Button size="small" type="text" icon={<BellOutlined />} aria-label="连接提醒设置" title="连接提醒设置" />
      </Popover>
    </div>
  );
}
