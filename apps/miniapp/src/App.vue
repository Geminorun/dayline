<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app';
onLaunch(() => {
  /* Visiting the app never creates a cloud account. */
});
</script>
<style>
page {
  background: #f6f4fa;
  color: #333443;
  font-family: system-ui, sans-serif;
}
.page {
  padding: 40rpx;
}
.card {
  background: #fff;
  border: 1rpx solid #e8e3ee;
  border-radius: 28rpx;
  padding: 36rpx;
}
.title {
  font-size: 44rpx;
  font-weight: 600;
  display: block;
  margin: 8rpx 0 28rpx;
}
.subtitle {
  font-size: 24rpx;
  color: #8b80a8;
  letter-spacing: 3rpx;
}
.text {
  display: block;
  font-size: 28rpx;
  line-height: 1.8;
  margin: 20rpx 0;
  word-break: break-all;
}
.muted {
  color: #76717e;
}
.error {
  color: #9c3b37;
  background: #fff0ef;
  border-radius: 12rpx;
  padding: 22rpx;
}
.notice {
  color: #3f7050;
  background: #edf5ef;
  border-radius: 12rpx;
  padding: 22rpx;
}
button {
  margin-top: 26rpx;
  background: #8b80b8;
  color: white;
  font-size: 30rpx;
  border-radius: 16rpx;
  min-height: 88rpx;
}
button.secondary {
  background: #efecf5;
  color: #51466e;
}
</style>
