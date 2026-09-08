import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import './App.css'

const Landing = lazy(() => import('./pages/Landing'))
const TimerApp = lazy(() => import('./pages/TimerApp'))
const OAuthRedirect = lazy(() => import('./pages/OAuthRedirect'))
const BillingSuccess = lazy(() => import('./pages/BillingSuccess'))
const BillingCancel = lazy(() => import('./pages/BillingCancel'))
const Account = lazy(() => import('./pages/Account'))

const deferPreload = window.requestIdleCallback || ((cb) => setTimeout(cb, 2000));
deferPreload(() => import('./pages/TimerApp'));

function App() {
  return (
    <Suspense fallback={
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh'}}>
        <div style={{width:32,height:32,border:'3px solid #e5e7eb',borderTopColor:'#3b82f6',borderRadius:'50%',animation:'spin 0.6s linear infinite'}} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    }>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<TimerApp />} />
        <Route path="/oauth/redirect" element={<OAuthRedirect />} />
        <Route path="/billing/success" element={<BillingSuccess />} />
        <Route path="/billing/cancel" element={<BillingCancel />} />
        <Route path="/account" element={<Account />} />
      </Routes>
    </Suspense>
  )
}

export default App
