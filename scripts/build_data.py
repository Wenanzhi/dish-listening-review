"""Export the frozen DiSH V3 release; never regenerate mixtures or labels."""
import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path
import numpy as np
import soundfile as sf

REVISION = '87e9f4d5394887d5d8a262ae8497ff2ba0089627'
REPO = 'Heiheihaha17/DiSH-Bench-exhibition-v3'

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def rows(p):
    with p.open() as f:
        for line in f:
            yield json.loads(line)

def write(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + '\n')

def build(dataset, sources, output):
    verify = json.loads((dataset / 'upload.verification.json').read_text())
    assert verify['verified_data_commit'] == REVISION and verify['passed']
    manifest = json.loads((dataset / 'manifest.json').read_text())
    hashes = {x['path']: x['sha256'] for x in manifest['files']}
    catalog, copied = [], {}
    for mode in ('static', 'dynamic'):
        files = ['public/test/inputs.jsonl', 'public/test/prompts.jsonl',
                 'private/test/gold.jsonl', 'private/test/episodes.jsonl']
        for f in files:
            assert digest(dataset / mode / f) == hashes[mode + '/' + f], f
        prompts = {x['sample_id']: x['rendered_prompt'] for x in rows(dataset / mode / files[1])}
        gold = {x['sample_id']: x for x in rows(dataset / mode / files[2])}
        questions = defaultdict(list)
        for x in rows(dataset / mode / files[0]):
            questions[x['episode_id']].append(dict(
                id=x['sample_id'], task=x['task_id'], setting=x['setting'],
                receiver_ids=x['receiver_ids'], prompt=prompts[x['sample_id']],
                query=x['query'], time_window_samples=x['time_window_samples'],
                audio=[dict(id=a['robot_id'], recording_id=a['recording_id'],
                            path=mode+'/'+a['path'], sha256=a['sha256']) for a in x['audio_bindings']]))
        for e in rows(dataset / mode / files[3]):
            eid=e['episode_id']; qs=questions[eid]; g=gold[qs[0]['id']]
            source_list=[]
            for person in e['humans'] + e.get('playback_sources', []):
                for event in person.get('events', []):
                    src=sources/event['audio_asset']; expected=event['original_source_sha256']
                    crop=event['crop_samples']; key=expected+'-'+str(crop[0])+'-'+str(crop[1])
                    target=output/'assets/sources'/(key+'.flac')
                    if key not in copied:
                        assert digest(src)==expected, src
                        assert sf.info(str(src)).subtype=='PCM_16', 'Expected lossless PCM16 LibriSpeech source'
                        data, rate=sf.read(str(src), dtype='int16', always_2d=True)
                        assert rate==16000 and data.shape[1]==1
                        segment=data[crop[0]:crop[1]]
                        assert len(segment)==crop[1]-crop[0]
                        target.parent.mkdir(parents=True, exist_ok=True)
                        sf.write(str(target), segment, rate, subtype='PCM_16')
                        copied[key]=dict(sha256=digest(target), samples=len(segment))
                    source_list.append(dict(entity_id=person['entity_id'],
                        event_id=event['event_id'], text=event['text'],
                        start=event['start_sample']/16000, end=event['end_sample']/16000,
                        crop_samples=crop, original_corpus_path=event.get('original_corpus_path'),
                        original_sha256=expected, license=event.get('source_license'),
                        audio='assets/sources/'+key+'.flac', **copied[key]))
            entry=dict(id=eid, base=e['base_scene_id'], room=e['room_id'], mode=mode,
                       duration=e['duration_samples']/16000, motion=e['branch'],
                       humans=len(e['humans']), receivers=len(e['robots']),
                       noise=g.get('noise_type'), snr=g.get('noise_nominal_snr_db'),
                       rt_bin=g.get('rt_bin'), playback=bool(e.get('playback_sources')),
                       questions=[dict(id=q['id'], task=q['task'], setting=q['setting']) for q in qs])
            catalog.append(entry)
            write(output/'data/scenes'/(eid+'.json'), dict(id=eid, duration=entry['duration'], questions=qs))
            reference=dict(id=eid, sources=source_list,
                entities=[dict(id=p['entity_id'], positions=p.get('positions_world_m', []),
                               yaw=p.get('yaw_deg', 0)) for p in e['humans']+e['robots']],
                questions={q['id']: gold[q['id']] for q in qs})
            write(output/'data/references'/(eid+'.json'), reference)
        print(mode, 'exported', len(questions), 'scenes', flush=True)
    write(output/'data/catalog.json', dict(version='dish-review-data-1', repo=REPO, revision=REVISION,
        protocol='dish_exhibition_v3.tasks.3', scenes=catalog,
        counts=dict(scenes=len(catalog), questions=sum(len(e['questions']) for e in catalog),
                    recordings=sum(e['receivers'] for e in catalog), source_crops=len(copied))))
    write(output/'data/provenance.json', dict(dataset=REPO, revision=REVISION,
        manifest_sha256=digest(dataset/'manifest.json'), source_crops=copied,
        source_transform='Lossless PCM16 crop at original sample boundaries; no gain or time shift',
        audio_transform='Original four-channel FLOAT WAV fetched from immutable Hugging Face revision'))
    print('Complete:', len(catalog), 'scenes;', len(copied), 'lossless source crops', flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--dataset',type=Path,required=True)
    p.add_argument('--sources',type=Path,required=True);p.add_argument('--output',type=Path,default=Path('web'))
    a=p.parse_args();build(a.dataset,a.sources,a.output)
