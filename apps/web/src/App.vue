<template>
  <div class="shell">
    <header>
      <RouterLink to="/login" class="brand"
        >日序 <span>Dayline</span></RouterLink
      >
      <nav aria-label="账号导航">
        <RouterLink to="/review">记录与回看</RouterLink>
        <RouterLink to="/login">登录</RouterLink
        ><RouterLink to="/register">注册</RouterLink
        ><RouterLink to="/account">当前账号</RouterLink>
      </nav>
    </header>
    <main><RouterView :key="$route.path" /></main>
    <footer>记录持续的经历，回看每天的重点。</footer>
  </div>
</template>
