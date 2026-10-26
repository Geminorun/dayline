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
  background: #f7f8fc;
  color: #303340;
  font-family:
    system-ui,
    -apple-system,
    'PingFang SC',
    sans-serif;
}
.page {
  padding: 32rpx 28rpx calc(40rpx + env(safe-area-inset-bottom));
  max-width: 100%;
  box-sizing: border-box;
}
.card {
  padding: 28rpx;
  margin: 24rpx 0;
  background: white;
  border: 1px solid #eef0f5;
  border-radius: 24rpx;
  box-sizing: border-box;
}
.title {
  display: block;
  font-size: 48rpx;
  font-weight: 700;
  margin: 18rpx 0 32rpx;
}
.subtitle {
  display: block;
  font-size: 22rpx;
  letter-spacing: 2rpx;
  color: #7970cf;
}
.heading {
  display: block;
  font-size: 32rpx;
  font-weight: 600;
  line-height: 1.6;
}
.text {
  display: block;
  line-height: 1.8;
  margin: 16rpx 0;
  word-break: break-word;
  font-size: 28rpx;
}
.muted {
  color: #727789;
}
.error,
.notice {
  display: block;
  padding: 24rpx;
  border-radius: 16rpx;
  line-height: 1.8;
}
.error {
  background: #fff0ef;
  color: #9c3b37;
}
.notice {
  background: #f0eefb;
  color: #5d54a0;
}
button {
  background: #7970cf;
  color: white;
  border-radius: 16rpx;
  font-size: 28rpx;
  min-height: 44px;
  line-height: 44px;
  margin: 16rpx 0;
}
button.secondary {
  background: #f0eefb;
  color: #5d54a0;
}
button::after {
  border: 0;
}
input {
  height: 48px;
  padding: 0 20rpx;
  border: 1px solid #dce0eb;
  border-radius: 14rpx;
  font-size: 28rpx;
  background: white;
  box-sizing: border-box;
  margin: 12rpx 0;
}
.picker {
  padding: 24rpx 20rpx;
  border: 1px solid #dce0eb;
  border-radius: 14rpx;
  font-size: 28rpx;
  min-height: 44px;
  box-sizing: border-box;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
  align-items: center;
}
.actions button {
  flex: 1;
  min-width: 140rpx;
  padding: 0 16rpx;
}
.actions picker {
  flex: 1;
  min-width: 180rpx;
}
.week-strip {
  display: flex;
  gap: 4rpx;
  justify-content: space-between;
}
.week-day {
  display: flex;
  flex: 1;
  min-height: 44px;
  flex-direction: column;
  justify-content: center;
  text-align: center;
  font-size: 22rpx;
  border-radius: 12rpx;
  color: #727789;
  padding: 8rpx 2rpx;
}
.week-day.selected {
  background: #7970cf;
  color: white;
}
.empty {
  text-align: center;
  padding: 40rpx 10rpx;
  color: #727789;
}
.dates-scroll {
  max-height: 280px;
  height: 200px;
}
.confirmation {
  position: sticky;
  bottom: 12px;
  z-index: 5;
  border: 2px solid #dba96c;
  background: #fff6ed;
}
</style>
