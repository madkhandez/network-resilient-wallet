import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { isOnline } from './api';
import { processQueue, hasPendingItems, reconcile } from './transferQueue';
import type { ServerTransfer } from './transferQueue';
import { apiFetch } from './api';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';

const INACTIVITY_LIMIT_MS = 15 * 60 * 1000; // 15 minutes

// --- Online/Offline Context ---
interface NetworkContextValue {
  online: boolean;
}

const NetworkContext = createContext<NetworkContextValue>({ online: true });

export function useNetwork() {
  return useContext(NetworkContext);
}

// --- Auth Guard with inactivity timer ---
const AuthGuard = ({ children }: { children: React.ReactNode }) => {
  const token = localStorage.getItem('jwt');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // --- Reconnect: process queue + reconcile ---
  const handleReconnect = useCallback(async () => {
    const jwt = localStorage.getItem('jwt');
    if (!jwt || !hasPendingItems()) return;

    // Process pending queue items
    const { authExpired } = await processQueue();

    if (authExpired) {
      // JWT expired during offline period — redirect to login
      // Queue is preserved in localStorage for after re-login
      localStorage.removeItem('jwt');
      navigate('/login');
      return;
    }

    // Reconcile: check server state against remaining pending items
    try {
      const serverTransfers: ServerTransfer[] = await apiFetch('/transfers');
      reconcile(serverTransfers);
    } catch {
      // Reconciliation failed — not critical, will retry next time
    }

    // Refresh server-authoritative data
    queryClient.invalidateQueries({ queryKey: ['profile'] });
    queryClient.invalidateQueries({ queryKey: ['transfers'] });
  }, [navigate, queryClient]);

  useEffect(() => {
    if (!token) return;

    const checkInactivity = () => {
      const lastActive = localStorage.getItem('last_active');
      if (lastActive && Date.now() - parseInt(lastActive, 10) > INACTIVITY_LIMIT_MS) {
        localStorage.removeItem('jwt');
        localStorage.removeItem('last_active');
        navigate('/login');
      }
    };

    const updateActivity = () => {
      localStorage.setItem('last_active', Date.now().toString());
    };

    // Initial check
    checkInactivity();
    updateActivity();

    const interval = setInterval(checkInactivity, 60000); // Check every minute
    
    const events = ['click', 'keypress', 'scroll', 'touchstart'] as const;
    events.forEach(e => window.addEventListener(e, updateActivity));

    // Online event: process pending queue on reconnect
    const onOnline = () => {
      handleReconnect();
    };
    window.addEventListener('online', onOnline);

    // On mount: if online and has pending items, process them
    // This handles the "browser reload with pending queue" scenario
    if (isOnline() && hasPendingItems()) {
      handleReconnect();
    }

    return () => {
      clearInterval(interval);
      events.forEach(e => window.removeEventListener(e, updateActivity));
      window.removeEventListener('online', onOnline);
    };
  }, [token, navigate, handleReconnect]);

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

function App() {
  const [online, setOnline] = useState(isOnline());

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <NetworkContext value={{ online }}>
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route 
            path="/" 
            element={
              <AuthGuard>
                <Dashboard />
              </AuthGuard>
            } 
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </NetworkContext>
  );
}

export default App;
