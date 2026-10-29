<script setup lang="ts">
import { useWorkspace } from './workspace';
import { onShow, onHide, onLaunch } from '@dcloudio/uni-app';
onShow(() => useWorkspace().lifecycle(true));
onHide(() => useWorkspace().lifecycle(false));
onLaunch(() => {
  void useWorkspace().ensure();
  uni.onNetworkStatusChange((status) => {
    if (status.isConnected) useWorkspace().networkRestored();
  });
});
</script>

<style>
page {
  background: #f6f7f4;
  color: #26352d;
  font-family:
    system-ui,
    -apple-system,
    'PingFang SC',
    sans-serif;
}
.page {
  --canvas: #f6f7f4;
  --surface: #fff;
  --surface-subtle: #f3f5f2;
  --ink: #26352d;
  --muted: #637268;
  --line: #dfe5de;
  --accent: #315c4d;
  --accent-ink: #315c4d;
  --accent-soft: #edf2ed;
  --on-accent: #fff;
  --danger: #b42318;
  --warning: #9a6700;
  --overlay: #26352d66;
  background: var(--canvas);
  color: var(--ink);
  padding: 24rpx 28rpx calc(40rpx + env(safe-area-inset-bottom));
  min-height: 100vh;
  box-sizing: border-box;
  overflow-wrap: anywhere;
}
.card {
  padding: 28rpx;
  margin: 24rpx 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 20rpx;
  box-sizing: border-box;
}
.title {
  display: block;
  font-size: 42rpx;
  font-weight: 700;
  margin: 8rpx 0 20rpx;
  line-height: 1.3;
}
.subtitle,
.eyebrow {
  display: block;
  font-size: 20rpx;
  letter-spacing: 2rpx;
  color: var(--muted);
}
.heading {
  display: block;
  font-size: 30rpx;
  font-weight: 600;
  line-height: 1.5;
}
.text {
  display: block;
  line-height: 1.65;
  margin: 14rpx 0;
  word-break: break-word;
  font-size: 26rpx;
}
.muted {
  color: var(--muted);
  font-size: 24rpx;
  line-height: 1.6;
}
.error {
  color: var(--danger);
}
.notice {
  color: var(--accent-ink);
}
.error,
.notice {
  font-size: 25rpx;
}
button {
  background: var(--accent);
  color: var(--on-accent);
  border-radius: 12rpx;
  font-size: 27rpx;
  min-height: 44px;
  line-height: 1.5;
  margin: 14rpx 0;
  padding: 20rpx 28rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10rpx;
  box-sizing: border-box;
}
button::after {
  border: 0;
}
button[disabled] {
  opacity: 0.45;
}
button.secondary {
  background: var(--surface-subtle);
  color: var(--ink);
  border: 1px solid var(--line);
}
button.danger {
  background: var(--danger);
  color: var(--surface);
}
.danger-ink {
  color: var(--danger);
}
input {
  min-width: 0;
  width: 100%;
  height: 44px;
  padding: 0 20rpx;
  border: 1px solid var(--line);
  border-radius: 12rpx;
  font-size: 28rpx;
  background: var(--surface);
  color: var(--ink);
  box-sizing: border-box;
  margin: 12rpx 0;
}
.picker {
  padding: 20rpx;
  border: 1px solid var(--line);
  border-radius: 12rpx;
  font-size: 27rpx;
  min-height: 44px;
  box-sizing: border-box;
  color: var(--ink);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
  align-items: center;
}
.actions button {
  flex: 1;
  min-width: 120rpx;
}
.actions picker {
  flex: 1;
  min-width: 180rpx;
}
.screen-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12rpx;
  min-height: 100rpx;
  margin-bottom: 20rpx;
}
.screen-heading .title {
  margin-bottom: 0;
}
.section-heading,
.settings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16rpx;
}
.settings-row {
  min-height: 44px;
}
.icon-button {
  width: 44px;
  height: 44px;
  min-width: 44px;
  min-height: 44px;
  padding: 10px;
  background: transparent;
  color: var(--ink);
  margin: 0;
  flex-shrink: 0;
}
.mini-icon {
  display: inline-block;
  flex-shrink: 0;
}
.selected {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.text-button {
  background: transparent;
  color: var(--accent-ink);
  margin: 0;
  padding: 14rpx;
  font-size: 24rpx;
}
.segmented {
  display: flex;
  background: var(--surface-subtle);
  padding: 4rpx;
  border-radius: 12rpx;
  margin: 20rpx 0;
}
.segmented button {
  flex: 1;
  background: transparent;
  color: var(--muted);
  margin: 0;
  font-size: 24rpx;
  padding: 14rpx 8rpx;
}
.segmented button.selected {
  background: var(--surface);
  color: var(--accent-ink);
}
.theme-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rpx;
}
.theme-choice {
  display: flex;
  justify-content: flex-start;
  background: transparent;
  color: var(--ink);
  font-size: 24rpx;
  margin: 0;
  padding: 16rpx;
  border: 1px solid var(--line);
  min-width: 0;
}
.theme-choice.selected {
  border-color: var(--accent-ink);
  background: var(--accent-soft);
}
.theme-swatch {
  width: 44rpx;
  height: 36rpx;
  border: 1px solid;
  border-radius: 6rpx;
  padding: 8rpx;
  flex-shrink: 0;
}
.theme-swatch view {
  height: 8rpx;
  border-radius: 3rpx;
}
.profile-card {
  display: flex;
  align-items: center;
  gap: 20rpx;
  flex-wrap: wrap;
}
.profile-main {
  flex: 1;
  min-width: 160rpx;
}
.profile-main .muted {
  display: block;
  margin-top: 8rpx;
}
.avatar {
  background: var(--accent-soft);
  color: var(--accent-ink);
  width: 88rpx;
  height: 88rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-weight: 650;
}
.menu-list {
  padding: 0 24rpx;
}
.menu-row {
  width: 100%;
  justify-content: flex-start;
  gap: 16rpx;
  background: transparent;
  color: var(--ink);
  border-radius: 0;
  margin: 0;
  padding: 24rpx 0;
  border-bottom: 1px solid var(--line);
  font-size: 27rpx;
  text-align: left;
}
.menu-row:last-child {
  border-bottom: 0;
}
.menu-row text {
  flex: 1;
}
.menu-row.danger-ink {
  color: var(--danger);
}
.sync-status {
  display: flex;
  justify-content: flex-end;
  min-width: 0;
}
.sync-trigger {
  font-size: 22rpx;
  color: var(--muted);
  background: transparent;
  margin: 0;
  padding: 12rpx 0;
  max-width: 300rpx;
}
.sync-trigger text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-spinner {
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--line);
  border-top-color: var(--accent-ink);
  border-radius: 50%;
  animation: mini-spin 0.9s linear infinite;
  flex-shrink: 0;
}
@keyframes mini-spin {
  to {
    transform: rotate(360deg);
  }
}
.sync-toast {
  position: fixed;
  left: 28rpx;
  right: 28rpx;
  bottom: calc(28rpx + env(safe-area-inset-bottom));
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 16rpx;
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 16rpx;
  padding: 18rpx 24rpx;
  font-size: 25rpx;
  box-shadow: 0 8rpx 32rpx #00000012;
}
.sync-toast text {
  flex: 1;
}
.sync-toast.error {
  color: var(--danger);
}
.week-strip {
  display: flex;
  gap: 4rpx;
  justify-content: space-between;
}
.week-day {
  display: flex;
  flex: 1;
  min-height: 72px;
  flex-direction: column;
  justify-content: center;
  text-align: center;
  font-size: 22rpx;
  border-radius: 12rpx;
  color: var(--muted);
  padding: 8rpx 2rpx;
}
.week-day.selected {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.empty {
  text-align: center;
  padding: 48rpx 16rpx;
  color: var(--muted);
}
.dates-scroll {
  max-height: 280px;
  height: 200px;
}
.confirmation {
  position: sticky;
  bottom: 12px;
  z-index: 5;
  border: 1px solid var(--line);
  background: var(--surface);
}
.sheet-mask {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  z-index: 60;
  display: flex;
  align-items: flex-end;
}
.sheet {
  width: 100%;
  max-height: 80vh;
  box-sizing: border-box;
  border-radius: 28rpx 28rpx 0 0;
  background: var(--surface);
  color: var(--ink);
  padding: 28rpx 28rpx calc(32rpx + env(safe-area-inset-bottom));
  overflow: auto;
}
.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
  margin-bottom: 16rpx;
}
.sheet-details {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 28rpx;
  margin: 28rpx 0;
}
.sheet-details .muted {
  display: block;
  margin-bottom: 6rpx;
}
</style>
