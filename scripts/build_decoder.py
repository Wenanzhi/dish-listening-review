"""Fit a reproducible 4-channel ACN/SN3D -> 2-ear FIR bank to MIT KEMAR."""
import argparse, hashlib, json, math
from pathlib import Path
import numpy as np
import h5py
from scipy.signal import resample_poly

SHA='647cebf09bd0ed5fca359c071d888779325a5c3376669b120029df817e7ea2bd'

def build(source, output):
    assert hashlib.sha256(source.read_bytes()).hexdigest()==SHA
    with h5py.File(str(source),'r') as f:
        positions=np.asarray(f['SourcePosition'],np.float64)
        ir=np.asarray(f['Data.IR'],np.float64)
        rate=int(np.asarray(f['Data.SamplingRate']).ravel()[0])
        assert np.all(np.asarray(f['Data.Delay'])==0)
        ears=np.asarray(f['ReceiverPosition']).squeeze()
        if ears[0,1]<ears[1,1]: ir=ir[:,::-1]; ears=ears[::-1]
        assert ears[0,1]>0>ears[1,1]
    az,el=np.deg2rad(positions[:,0]),np.deg2rad(positions[:,1])
    basis=np.column_stack([np.ones(len(positions)),np.sin(az)*np.cos(el),np.sin(el),np.cos(az)*np.cos(el)])
    gram=basis.T@basis
    fitted=np.linalg.solve(gram+1e-6*np.trace(gram)/4*np.eye(4),basis.T@ir.reshape(len(ir),-1))
    filters=fitted.reshape(4,2,ir.shape[-1]).transpose(1,0,2)
    d=math.gcd(rate,16000);filters=resample_poly(filters,16000//d,rate//d,axis=-1)
    # Synthetic left/right waves must have greater energy at the corresponding ear.
    for sign in (1,-1):
        y=np.einsum('ecn,c->en',filters,np.array([1,sign,0,0]))
        power=np.sum(y*y,axis=1)
        assert power[0]>power[1] if sign==1 else power[1]>power[0]
    obj=dict(id='kemar-acn-sn3d-fir-v1',rate=16000,channels=['W','Y','Z','X'],
        filters=filters.astype('float32').tolist(),source_sha256=SHA,
        source_url='https://sofacoustics.org/data/sofatoolbox_test/MIT_KEMAR_normal_pinna.sofa',
        attribution='Bill Gardner and Keith Martin, MIT Media Laboratory, 1994',
        terms='https://sound.media.mit.edu/resources/KEMAR.html',
        method='Regularized first-order projection of measured KEMAR HRIRs; ridge 1e-6; no ear-independent delay or normalization',
        orientation='Receiver-local +X front, +Y left, +Z up; fixed head aligned with receiver',
        synthetic_left_right_check=True)
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(obj))
    print('Decoder written; left/right numerical checks passed')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('output',type=Path)
    a=p.parse_args();build(a.source,a.output)
