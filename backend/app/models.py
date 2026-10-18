from __future__ import annotations
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from .config import MODELS_DIR

AI_NUM=['pre_event_speed_kmh','post_event_speed_kmh','speed_drop_kmh','peak_deceleration_mps2',
        'mean_deceleration_mps2','max_jerk_mps3','event_duration_sec','hour','dayofweek']
AI_CAT=['vehicle_type','road_type','traffic_density','weather','road_surface','speed_regime','gps_quality','sensor_quality']
AI_FEATURES=AI_NUM+AI_CAT

def _speed_regime(v: float) -> str:
    return 'low' if v <= 20 else ('medium' if v <= 60 else 'high')

def feature_row(event: dict) -> pd.DataFrame:
    d=dict(event)
    pre=float(d.get('pre_event_speed_kmh',0) or 0)
    post=d.get('post_event_speed_kmh')
    if post is None: post=max(0.0, pre-float(d.get('speed_drop_kmh',0) or 0))
    drop=d.get('speed_drop_kmh')
    if drop is None: drop=max(0.0,pre-float(post))
    peak=float(d.get('peak_deceleration_mps2',0) or 0)
    mean=d.get('mean_deceleration_mps2')
    if mean is None: mean=peak*0.62
    jerk=d.get('max_jerk_mps3')
    duration=max(float(d.get('event_duration_sec',1.0) or 1.0),0.05)
    if jerk is None: jerk=peak/max(min(duration*0.35,1.5),0.15)
    ts=pd.to_datetime(d.get('timestamp_start'),utc=True,errors='coerce')
    if pd.isna(ts): ts=pd.Timestamp.now(tz='UTC')
    row={
        'pre_event_speed_kmh':pre,'post_event_speed_kmh':float(post),'speed_drop_kmh':float(drop),
        'peak_deceleration_mps2':peak,'mean_deceleration_mps2':float(mean),'max_jerk_mps3':float(jerk),
        'event_duration_sec':duration,'hour':int(ts.hour),'dayofweek':int(ts.dayofweek),
        'vehicle_type':d.get('vehicle_type','passenger_car'),'road_type':d.get('road_type','urban'),
        'traffic_density':d.get('traffic_density','medium'),'weather':d.get('weather','clear'),
        'road_surface':d.get('road_surface','dry_asphalt'),'speed_regime':d.get('speed_regime') or _speed_regime(pre),
        'gps_quality':d.get('gps_quality','high'),'sensor_quality':d.get('sensor_quality','high')
    }
    return pd.DataFrame([row])

class ModelHub:
    def __init__(self, model_dir: Path=MODELS_DIR):
        self.pre=joblib.load(model_dir/'CALIBR8_AI_preprocessor.joblib')
        self.xgb=joblib.load(model_dir/'CALIBR8_XGBoost_harsh_braking.joblib')
        self.lgb=joblib.load(model_dir/'CALIBR8_LightGBM_harsh_braking.joblib')
        self.ai_meta=json.loads((model_dir/'CALIBR8_AI_metadata.json').read_text())
        self.friend=joblib.load(model_dir/'CALIBR8_friend_GBM.joblib')
        self.friend_meta=json.loads((model_dir/'CALIBR8_friend_GBM_metadata.json').read_text())

    def new_ai(self,event:dict,mode:str='balanced')->dict:
        df=feature_row(event)
        X=self.pre.transform(df[AI_FEATURES])
        px=float(self.xgb.predict_proba(X)[0,1]); pl=float(self.lgb.predict_proba(X)[0,1])
        w=float(self.ai_meta.get('ensemble_weights',{}).get('xgboost',0.60))
        p=w*px+(1-w)*pl
        threshold=float(self.ai_meta.get('balanced_threshold',0.46) if mode=='balanced' else self.ai_meta.get('safety_threshold',0.285))
        harsh=p>=threshold
        return {'model':'CALIBR8-AI XGBoost+LightGBM','mode':mode,'probability_harsh':p,'threshold':threshold,
                'harsh_or_severe':bool(harsh),'prediction':'harsh_or_severe' if harsh else 'normal_or_mild',
                'components':{'xgboost_probability':px,'lightgbm_probability':pl,'xgboost_weight':w,'lightgbm_weight':1-w}}

    def friend_gbm(self,event:dict)->dict:
        df=feature_row(event)
        num=self.friend_meta['numeric_features']; cat=self.friend_meta['categorical_features']; levels=self.friend_meta['category_levels']
        X=df[num].copy()
        for c in cat:
            X[c]=pd.Categorical(df[c],categories=levels[c]).codes
        probs=self.friend.predict_proba(X)[0]
        classes=list(self.friend.classes_)
        pmap={str(c):float(p) for c,p in zip(classes,probs)}
        p_hs=sum(pmap.get(c,0.0) for c in ('harsh_braking','severe_braking'))
        pred=str(self.friend.predict(X)[0]); harsh=pred in {'harsh_braking','severe_braking'}
        return {'model':'Friend GBM (HistGradientBoosting)','mode':'4-class argmax','probability_harsh':p_hs,
                'threshold':None,'harsh_or_severe':harsh,'prediction':pred,'class_probabilities':pmap}
